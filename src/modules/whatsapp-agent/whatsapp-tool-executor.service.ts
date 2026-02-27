import { Injectable, Logger } from "@nestjs/common";
import type { ExtractedAiSearchParams } from "../ai-search/ai-search.interface";
import { AiSearchService } from "../ai-search/ai-search.service";
import { CarSearchService } from "../car/car-search.service";
import { RatesService } from "../rates/rates.service";
import {
  parseWhatsAppAgentToolInput,
  type SearchVehiclesToolInput,
  type WhatsAppAgentToolDefinition,
  type WhatsAppAgentToolName,
  whatsappAgentEnabledToolDefinitions,
  whatsappAgentEnabledToolNames,
  whatsappAgentToolSchemas,
} from "./tools";
import { VehicleSearchAlternativeRanker } from "./vehicle-search-alternative.ranker";
import {
  normalizeBookingType,
  parseSearchDate,
  VehicleSearchPreconditionPolicy,
} from "./vehicle-search-precondition.policy";
import { VehicleSearchQueryBuilder } from "./vehicle-search-query.builder";
import {
  WHATSAPP_AI_SEARCH_TIMEOUT_MS,
  WHATSAPP_CAR_SEARCH_TIMEOUT_MS,
  WHATSAPP_MAX_SEARCH_MESSAGE_CHARS,
} from "./whatsapp-agent.const";
import {
  WhatsAppOperationTimeoutException,
  WhatsAppToolNotEnabledException,
  WhatsAppToolUnknownException,
} from "./whatsapp-agent.error";
import type {
  VehicleSearchAlternative,
  VehicleSearchMessageResult,
  VehicleSearchToolResult,
} from "./whatsapp-agent.interface";
import { WhatsAppSearchSlotMemoryService } from "./whatsapp-search-slot-memory.service";

@Injectable()
export class WhatsAppToolExecutorService {
  private readonly logger = new Logger(WhatsAppToolExecutorService.name);
  private readonly maxExactMatches = 3;
  private readonly maxAlternatives = 3;
  private readonly maxSearchCandidates = 10;
  private readonly preconditionPolicy = new VehicleSearchPreconditionPolicy();
  private readonly queryBuilder = new VehicleSearchQueryBuilder(this.maxSearchCandidates);
  private readonly alternativeRanker = new VehicleSearchAlternativeRanker(
    this.maxExactMatches,
    this.maxAlternatives,
  );

  constructor(
    private readonly aiSearchService: AiSearchService,
    private readonly carSearchService: CarSearchService,
    private readonly slotMemoryService: WhatsAppSearchSlotMemoryService,
    private readonly ratesService: RatesService,
  ) {}

  getAvailableTools(): readonly WhatsAppAgentToolDefinition[] {
    return whatsappAgentEnabledToolDefinitions;
  }

  async execute(toolName: WhatsAppAgentToolName, input: unknown): Promise<unknown> {
    const enabledToolNames = whatsappAgentEnabledToolNames as readonly string[];
    switch (toolName) {
      case "search_vehicles":
        if (!enabledToolNames.includes(toolName)) {
          throw new WhatsAppToolNotEnabledException(toolName);
        }
        return this.searchVehiclesFromToolInput(
          parseWhatsAppAgentToolInput("search_vehicles", input),
        );
      case "get_quote":
      case "create_booking":
      case "check_booking_status":
      case "send_payment_link":
        if (!enabledToolNames.includes(toolName)) {
          throw new WhatsAppToolNotEnabledException(toolName);
        }
        throw new WhatsAppToolUnknownException(toolName);
      default:
        if (Object.hasOwn(whatsappAgentToolSchemas, toolName)) {
          throw new WhatsAppToolNotEnabledException(toolName);
        }
        throw new WhatsAppToolUnknownException(toolName);
    }
  }

  async searchVehiclesFromMessage(
    message: string,
    conversationId?: string,
  ): Promise<VehicleSearchMessageResult> {
    const startedAt = Date.now();
    const content = message.trim().slice(0, WHATSAPP_MAX_SEARCH_MESSAGE_CHARS);
    if (!content) {
      return { kind: "no_intent" };
    }

    try {
      const aiSearch = await this.withTimeout(
        this.aiSearchService.search(content),
        "ai-search",
        WHATSAPP_AI_SEARCH_TIMEOUT_MS,
      );
      const latestExtracted = aiSearch.raw;
      if (!this.hasSearchSignal(latestExtracted)) {
        return { kind: "no_intent" };
      }
      const merged =
        conversationId == null
          ? {
              extracted: latestExtracted,
              dialogState: {
                bookingTypeConfirmed: Boolean(latestExtracted.bookingType),
                lastAskedQuestionType: null,
                lastAskedAt: null,
              },
            }
          : await this.slotMemoryService.mergeWithLatest(conversationId, latestExtracted);

      const result = await this.searchVehiclesFromExtracted(
        merged.extracted,
        aiSearch.interpretation,
        merged.dialogState,
      );

      if (result.precondition) {
        if (conversationId) {
          await this.slotMemoryService.recordQuestionAsked(conversationId, "precondition");
        }
        return { kind: "ask_precondition", result };
      }

      if (result.shouldClarifyBookingType) {
        if (conversationId) {
          await this.slotMemoryService.recordQuestionAsked(conversationId, "booking_clarification");
        }
        return { kind: "ask_booking_clarification", result };
      }

      if (conversationId) {
        await this.slotMemoryService.clearAskedQuestion(conversationId);
      }

      if (result.exactMatches.length === 0 && result.alternatives.length === 0) {
        return { kind: "no_options", result };
      }

      return { kind: "show_options", result };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn("Tool search flow failed for WhatsApp message", {
        durationMs: Date.now() - startedAt,
        error: errorMessage,
      });
      return {
        kind: "error",
        error: "An internal error occurred while processing your request.",
      };
    }
  }

  private async searchVehiclesFromToolInput(
    input: SearchVehiclesToolInput,
  ): Promise<VehicleSearchToolResult | null> {
    const { make, model } = this.queryBuilder.parseVehicleModel(input.vehicleModel);
    const extracted: ExtractedAiSearchParams = {
      from: input.pickupDate,
      to: input.dropoffDate,
      bookingType: input.bookingType,
      color: input.vehicleColor,
      pickupTime: input.pickupTime,
      pickupLocation: input.pickupLocation,
      dropoffLocation: input.dropoffLocation,
      flightNumber: input.flightNumber,
      make,
      model,
      ...this.queryBuilder.mapVehicleCategory(input.vehicleCategory),
    };

    if (!this.hasSearchSignal(extracted)) {
      return null;
    }

    const interpretation = this.queryBuilder.buildInterpretationFromExtracted(extracted);
    return this.searchVehiclesFromExtracted(extracted, interpretation);
  }

  private async searchVehiclesFromExtracted(
    extracted: ExtractedAiSearchParams,
    interpretation: string,
    dialogState?: {
      bookingTypeConfirmed?: boolean;
      lastAskedQuestionType?: "precondition" | "booking_clarification" | null;
    },
  ): Promise<VehicleSearchToolResult> {
    const precondition = this.preconditionPolicy.resolve(extracted);
    if (precondition) {
      this.logger.debug("Returning search precondition prompt", {
        missingField: precondition.missingField,
      });
      return {
        interpretation,
        extracted,
        exactMatches: [],
        alternatives: [],
        precondition,
        shouldClarifyBookingType: false,
      };
    }

    const exactQuery = this.queryBuilder.buildExactQuery(extracted);
    const exactResults = await this.withTimeout(
      this.carSearchService.searchCars(exactQuery),
      "car-search:exact",
      WHATSAPP_CAR_SEARCH_TIMEOUT_MS,
    );
    const exactCandidates = exactResults.cars.map((car) =>
      this.alternativeRanker.mapCarToOption(car),
    );
    const exactMatches = this.alternativeRanker.selectExactMatches(exactCandidates, extracted);

    let alternatives: VehicleSearchAlternative[] = [];
    if (exactMatches.length === 0) {
      const alternativeQueries = this.queryBuilder.buildAlternativeQueries(extracted);
      const settledAlternativeResults = await Promise.allSettled(
        alternativeQueries.map(async (query, index) =>
          this.withTimeout(
            this.carSearchService.searchCars(query),
            `car-search:alternative:${index + 1}`,
            WHATSAPP_CAR_SEARCH_TIMEOUT_MS,
          ),
        ),
      );
      const alternativeResults = settledAlternativeResults.flatMap((result, index) => {
        if (result.status === "fulfilled") {
          return [result.value];
        }
        const operation = `car-search:alternative:${index + 1}`;
        this.logger.warn("Alternative car search query failed", {
          operation,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
        return [];
      });
      const alternativeCandidates = alternativeResults.flatMap((result) =>
        result.cars.map((car) => this.alternativeRanker.mapCarToOption(car)),
      );
      alternatives = this.alternativeRanker.rankAlternatives(
        [...exactCandidates, ...alternativeCandidates],
        extracted,
      );
    }

    const vatRatePercent = await this.resolveVatRatePercent();
    const enrichedExactMatches = exactMatches.map((option) =>
      this.applyEstimate(option, extracted, vatRatePercent),
    );
    const enrichedAlternatives = alternatives.map((option) =>
      this.applyEstimate(option, extracted, vatRatePercent),
    );

    return {
      interpretation,
      extracted,
      exactMatches: enrichedExactMatches,
      alternatives: enrichedAlternatives,
      precondition: null,
      shouldClarifyBookingType: this.preconditionPolicy.shouldClarifyBookingType(extracted, {
        bookingTypeConfirmed: dialogState?.bookingTypeConfirmed,
        lastAskedQuestionType: dialogState?.lastAskedQuestionType,
      }),
    };
  }

  private hasSearchSignal(extracted: ExtractedAiSearchParams): boolean {
    return Boolean(
      extracted.color ||
        extracted.make ||
        extracted.model ||
        extracted.vehicleType ||
        extracted.serviceTier ||
        extracted.from ||
        extracted.to ||
        extracted.bookingType ||
        extracted.pickupTime ||
        extracted.pickupLocation ||
        extracted.dropoffLocation ||
        extracted.flightNumber,
    );
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    operation: string,
    timeoutMs: number,
  ): Promise<T> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new WhatsAppOperationTimeoutException(operation, timeoutMs));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private async resolveVatRatePercent(): Promise<number> {
    try {
      const rates = await this.ratesService.getRates();
      return rates.vatRatePercent.toNumber();
    } catch (error) {
      this.logger.warn("Failed to resolve VAT rate for search estimate", {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  private applyEstimate<T extends VehicleSearchAlternative>(
    option: T,
    extracted: ExtractedAiSearchParams,
    vatRatePercent: number,
  ): T;
  private applyEstimate<
    T extends { rates: VehicleSearchToolResult["exactMatches"][number]["rates"] },
  >(option: T, extracted: ExtractedAiSearchParams, vatRatePercent: number): T;
  private applyEstimate<
    T extends {
      rates: {
        day: number;
        night: number | null;
        fullDay: number | null;
        airportPickup: number | null;
      };
    },
  >(option: T, extracted: ExtractedAiSearchParams, vatRatePercent: number): T {
    const bookingType = normalizeBookingType(extracted.bookingType) ?? "DAY";
    const quantity = this.resolveEstimatedQuantity(extracted, bookingType);
    const ratePerUnit = this.resolveRatePerUnit(option.rates, bookingType);
    const subtotal = Math.max(0, Math.round(ratePerUnit * quantity));
    const vatAmount = Math.max(0, Math.round((subtotal * vatRatePercent) / 100));
    const total = subtotal + vatAmount;
    return {
      ...option,
      estimatedSubtotal: subtotal,
      estimatedVatAmount: vatAmount,
      estimatedTotalInclVat: total,
      estimateBasis: `${quantity} ${bookingType} ${quantity > 1 ? "legs" : "leg"}`,
    };
  }

  private resolveEstimatedQuantity(
    extracted: ExtractedAiSearchParams,
    bookingType: "DAY" | "NIGHT" | "FULL_DAY" | "AIRPORT_PICKUP",
  ): number {
    if (bookingType === "AIRPORT_PICKUP") {
      return 1;
    }
    const fromDate = parseSearchDate(extracted.from);
    const toDate = parseSearchDate(extracted.to);
    if (!fromDate || !toDate) {
      return 1;
    }
    const dayMs = 24 * 60 * 60 * 1000;
    const diffDays = Math.floor((toDate.getTime() - fromDate.getTime()) / dayMs);
    return Math.max(1, diffDays + 1);
  }

  private resolveRatePerUnit(
    rates: {
      day: number;
      night: number | null;
      fullDay: number | null;
      airportPickup: number | null;
    },
    bookingType: "DAY" | "NIGHT" | "FULL_DAY" | "AIRPORT_PICKUP",
  ): number {
    switch (bookingType) {
      case "NIGHT":
        return rates.night ?? rates.day;
      case "FULL_DAY":
        return rates.fullDay ?? rates.day;
      case "AIRPORT_PICKUP":
        return rates.airportPickup ?? rates.day;
      default:
        return rates.day;
    }
  }
}
