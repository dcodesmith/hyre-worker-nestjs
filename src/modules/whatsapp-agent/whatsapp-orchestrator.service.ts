import { Injectable, Logger } from "@nestjs/common";
import { WhatsAppMessageKind } from "@prisma/client";
import type {
  InboundMessageContext,
  OrchestratorResult,
  VehicleSearchMessageResult,
  VehicleSearchOption,
  VehicleSearchToolResult,
} from "./whatsapp-agent.interface";
import { WhatsAppFollowupQuestionService } from "./whatsapp-followup-question.service";
import { WhatsAppSearchSlotMemoryService } from "./whatsapp-search-slot-memory.service";
import { WhatsAppToolExecutorService } from "./whatsapp-tool-executor.service";
import { WhatsAppWindowPolicyService } from "./whatsapp-window-policy.service";

@Injectable()
export class WhatsAppOrchestratorService {
  private readonly logger = new Logger(WhatsAppOrchestratorService.name);

  constructor(
    private readonly windowPolicyService: WhatsAppWindowPolicyService,
    private readonly toolExecutorService: WhatsAppToolExecutorService,
    private readonly followupQuestionService: WhatsAppFollowupQuestionService,
    private readonly searchSlotMemoryService: WhatsAppSearchSlotMemoryService,
  ) {}

  /**
   * MVP baseline:
   * - route explicit handoff requests immediately
   * - keep all other intents in deterministic no-op mode until booking flows are wired
   */
  async decide(
    context: InboundMessageContext & {
      windowExpiresAt?: Date | null;
    },
  ): Promise<OrchestratorResult> {
    const body = context.body?.trim().toUpperCase() ?? "";
    if (body === "AGENT") {
      return {
        enqueueOutbox: [
          {
            conversationId: context.conversationId,
            dedupeKey: `handoff-ack:${context.messageId}`,
            mode: this.windowPolicyService.resolveOutboundMode(context.windowExpiresAt),
            textBody:
              "A Tripdly agent will join this chat shortly. Please share your booking reference if available.",
            templateName: "handoff-reopen",
          },
        ],
        markAsHandoff: { reason: "USER_REQUESTED_AGENT" },
      };
    }

    if (body === "RESET" || body === "START OVER") {
      await this.searchSlotMemoryService.clear(context.conversationId);
      return {
        enqueueOutbox: [
          {
            conversationId: context.conversationId,
            dedupeKey: `reset-ack:${context.messageId}`,
            mode: this.windowPolicyService.resolveOutboundMode(context.windowExpiresAt),
            textBody:
              "Done - I have reset your current booking details. Please share your new request.",
            templateName: "booking-reopen",
          },
        ],
      };
    }

    // Voice/media-specific fallback prompt for MVP until transcription/media flows are enabled.
    if (
      context.kind === WhatsAppMessageKind.AUDIO ||
      context.kind === WhatsAppMessageKind.DOCUMENT ||
      context.kind === WhatsAppMessageKind.IMAGE
    ) {
      return {
        enqueueOutbox: [
          {
            conversationId: context.conversationId,
            dedupeKey: `media-fallback:${context.messageId}`,
            mode: this.windowPolicyService.resolveOutboundMode(context.windowExpiresAt),
            textBody:
              "Thanks. For now, please send your pickup location, date/time, and booking type (DAY, NIGHT, or FULL_DAY) as text.",
            templateName: "booking-reopen",
          },
        ],
      };
    }

    const mode = this.windowPolicyService.resolveOutboundMode(context.windowExpiresAt);
    const searchMessageResult: VehicleSearchMessageResult =
      await this.toolExecutorService.searchVehiclesFromMessage(
        context.body ?? "",
        context.conversationId,
      );
    if (searchMessageResult.kind === "error") {
      this.logger.error("Search tool execution returned error result in orchestrator", {
        error: searchMessageResult.error,
      });
      return {
        enqueueOutbox: [
          {
            conversationId: context.conversationId,
            dedupeKey: `tool-failure:${context.messageId}`,
            mode,
            textBody:
              "I hit a temporary issue while checking availability. Please resend your request in a moment.",
            templateName: "booking-reopen",
          },
        ],
      };
    }

    if (searchMessageResult.kind === "no_intent") {
      return {
        enqueueOutbox: [
          {
            conversationId: context.conversationId,
            dedupeKey: `collect-details:${context.messageId}`,
            mode,
            textBody:
              "I can help you find a car. Share pickup date, drop-off date, booking type (DAY, NIGHT, FULL_DAY or AIRPORT_PICKUP), and any preference like SUV, color, or brand.",
            templateName: "booking-reopen",
          },
        ],
      };
    }

    if (searchMessageResult.kind === "ask_precondition") {
      const searchResult: VehicleSearchToolResult = searchMessageResult.result;
      const textBody = await this.followupQuestionService.buildFriendlyQuestion({
        intent: "precondition",
        customerMessage: context.body,
        extracted: searchResult.extracted,
        missingFields: [searchResult.precondition.missingField],
        fallbackQuestion: searchResult.precondition.prompt,
      });
      return {
        enqueueOutbox: [
          {
            conversationId: context.conversationId,
            dedupeKey: `collect-precondition:${context.messageId}:${searchResult.precondition.missingField}`,
            mode,
            textBody,
            templateName: "booking-reopen",
          },
        ],
      };
    }

    if (searchMessageResult.kind === "ask_booking_clarification") {
      const searchResult: VehicleSearchToolResult = searchMessageResult.result;
      const fallbackPrompt = this.buildBookingClarificationPrompt(searchResult);
      const textBody = await this.followupQuestionService.buildFriendlyQuestion({
        intent: "booking_clarification",
        customerMessage: context.body,
        extracted: searchResult.extracted,
        missingFields: this.resolveBookingClarificationMissingFields(searchResult),
        fallbackQuestion: fallbackPrompt,
      });
      return {
        enqueueOutbox: [
          {
            conversationId: context.conversationId,
            dedupeKey: `collect-booking-clarification:${context.messageId}`,
            mode,
            textBody,
            templateName: "booking-reopen",
          },
        ],
      };
    }

    if (searchMessageResult.kind === "no_options") {
      return this.buildNoOptionsResponse(context.conversationId, context.messageId, mode);
    }

    const searchResult: VehicleSearchToolResult = searchMessageResult.result;
    const displayOptions = this.getDisplayOptions(searchResult);
    if (displayOptions.length === 0) {
      return this.buildNoOptionsResponse(context.conversationId, context.messageId, mode);
    }

    const outboxItems: OrchestratorResult["enqueueOutbox"] = [
      {
        conversationId: context.conversationId,
        dedupeKey: `options-list:${context.messageId}`,
        mode,
        textBody: this.buildVehicleOptionsMessage(searchResult),
      },
    ];

    displayOptions.forEach((option, index) => {
      if (!option.imageUrl) {
        return;
      }

      outboxItems.push({
        conversationId: context.conversationId,
        dedupeKey: `option-image:${context.messageId}:${option.id}`,
        mode,
        textBody: `${index + 1}. ${option.name}`,
        mediaUrl: option.imageUrl,
      });
    });

    return { enqueueOutbox: outboxItems };
  }

  private buildVehicleOptionsMessage(result: VehicleSearchToolResult): string {
    const isAlternativeResponse = result.exactMatches.length === 0;
    const options = this.getDisplayOptions(result);
    const lines = options.map((option, index) =>
      this.buildOptionLine(option, index + 1, isAlternativeResponse),
    );

    const responseSections = [
      this.buildSearchHeader(result, isAlternativeResponse),
      lines.join("\n"),
      "Reply with the option number to continue.",
    ];

    return responseSections.join("\n\n");
  }

  private getDisplayOptions(
    result: VehicleSearchToolResult,
  ): Array<VehicleSearchOption & { reason?: string }> {
    if (result.exactMatches.length > 0) {
      return result.exactMatches;
    }
    return result.alternatives;
  }

  private buildSearchHeader(
    result: VehicleSearchToolResult,
    isAlternativeResponse: boolean,
  ): string {
    if (!isAlternativeResponse) {
      if (result.interpretation) {
        return `Available options for: ${result.interpretation}`;
      }
      return "Here are available options:";
    }

    const requestedVehicle = this.buildRequestedVehicleLabel(result);
    if (requestedVehicle) {
      return `No exact ${requestedVehicle} available for those details, but here are close alternatives and their prices including VAT:`;
    }
    return "No exact match found for those details, but here are close alternatives and their prices including VAT:";
  }

  private buildRequestedVehicleLabel(result: VehicleSearchToolResult): string {
    const parts = [
      result.extracted.color?.toLowerCase(),
      result.extracted.make,
      result.extracted.model,
      result.extracted.vehicleType?.toLowerCase().replaceAll("_", " "),
    ].filter(Boolean);
    return parts.join(" ").trim();
  }

  private buildOptionLine(
    option: VehicleSearchOption & { reason?: string },
    displayIndex: number,
    includeAlternativeReason: boolean,
  ): string {
    const estimate =
      typeof option.estimatedTotalInclVat === "number"
        ? `Estimated total (incl. VAT) ₦${option.estimatedTotalInclVat.toLocaleString()}`
        : null;

    const color = option.color ? ` (${option.color})` : "";
    const baseLine = `${displayIndex}. ${option.name}${color} — ${estimate ?? "Estimated total unavailable"}`;
    if (!includeAlternativeReason || !option.reason) {
      return baseLine;
    }

    return `${baseLine} [${this.formatAlternativeReason(option.reason)}]`;
  }

  private formatAlternativeReason(reason: string): string {
    switch (reason) {
      case "SAME_MODEL_DIFFERENT_COLOR":
        return "same model, different color";
      case "SAME_COLOR_SIMILAR_CLASS":
        return "same color, similar class";
      case "SIMILAR_CLASS":
        return "similar class";
      case "SIMILAR_PRICE_RANGE":
        return "similar price range";
      default:
        return "closest available";
    }
  }

  private buildBookingClarificationPrompt(result: VehicleSearchToolResult): string {
    const basePrompt =
      "How should I price this?\n• DAY (6am-6pm)\n• NIGHT (6pm-6am)\n• FULL_DAY (24hrs with chauffeur)\nReply with DAY, NIGHT, or FULL_DAY.";

    const pickupLocation = result.extracted.pickupLocation?.trim();
    const dropoffLocation = result.extracted.dropoffLocation?.trim();
    if (pickupLocation && dropoffLocation) {
      return basePrompt;
    }

    if (!pickupLocation && !dropoffLocation) {
      return `${basePrompt}\nAlso share pickup and drop-off locations (landmark/address).`;
    }

    if (!pickupLocation) {
      return `${basePrompt}\nAlso share your pickup location (landmark/address).`;
    }

    return `${basePrompt}\nAlso share your drop-off location (landmark/address).`;
  }

  private resolveBookingClarificationMissingFields(result: VehicleSearchToolResult): string[] {
    const missing: string[] = ["bookingType"];
    if (!result.extracted.pickupLocation?.trim()) {
      missing.push("pickupLocation");
    }
    if (!result.extracted.dropoffLocation?.trim()) {
      missing.push("dropoffLocation");
    }
    return missing;
  }

  private buildNoOptionsResponse(
    conversationId: string,
    messageId: string,
    mode: OrchestratorResult["enqueueOutbox"][number]["mode"],
  ): OrchestratorResult {
    return {
      enqueueOutbox: [
        {
          conversationId,
          dedupeKey: `no-options:${messageId}`,
          mode,
          textBody:
            "I could not find available cars for those details. Please try another date, booking type, or broader vehicle preferences.",
          templateName: "booking-reopen",
        },
      ],
    };
  }
}
