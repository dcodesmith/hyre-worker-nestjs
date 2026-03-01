import { Injectable, Logger } from "@nestjs/common";
import type { BookingType } from "@prisma/client";
import type { ExtractedAiSearchParams } from "../ai-search/ai-search.interface";
import { calculateLegCount } from "../booking/booking.helper";
import { CarSearchService } from "../car/car-search.service";
import { RatesService } from "../rates/rates.service";
import { WHATSAPP_CAR_SEARCH_TIMEOUT_MS } from "./booking-agent.const";
import { WhatsAppOperationTimeoutException } from "./booking-agent.error";
import type { VehicleSearchAlternative, VehicleSearchToolResult } from "./booking-agent.interface";
import { VehicleSearchAlternativeRanker } from "./vehicle-search-alternative.ranker";
import {
  normalizeBookingType,
  parseSearchDate,
  VehicleSearchPreconditionPolicy,
} from "./vehicle-search-precondition.policy";
import { VehicleSearchQueryBuilder } from "./vehicle-search-query.builder";

@Injectable()
export class BookingAgentSearchService {
  private readonly logger = new Logger(BookingAgentSearchService.name);
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
    private readonly carSearchService: CarSearchService,
    private readonly ratesService: RatesService,
  ) {}

  async searchVehiclesFromExtracted(
    extracted: ExtractedAiSearchParams,
    interpretation: string,
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
      shouldClarifyBookingType: false,
    };
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

  /**
   * Calculate the estimated number of legs for price estimation.
   * Uses the shared calculateLegCount helper from booking module to ensure
   * consistency between estimates and actual booking creation.
   */
  private resolveEstimatedQuantity(
    extracted: ExtractedAiSearchParams,
    bookingType: BookingType,
  ): number {
    const fromDate = parseSearchDate(extracted.from);
    const toDate = parseSearchDate(extracted.to);
    if (!fromDate || !toDate) {
      return 1;
    }
    return calculateLegCount(bookingType, fromDate, toDate);
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
