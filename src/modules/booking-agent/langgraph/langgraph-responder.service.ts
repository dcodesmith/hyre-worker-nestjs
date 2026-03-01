import { Inject, Injectable, Logger } from "@nestjs/common";
import { BookingType } from "@prisma/client";
import { LANGGRAPH_BUTTON_ID } from "./langgraph.const";
import { LangGraphResponseFailedException } from "./langgraph.error";
import type {
  AgentResponse,
  BookingAgentState,
  BookingDraft,
  BookingStage,
  InteractivePayload,
  VehicleCard,
  VehicleSearchOption,
} from "./langgraph.interface";
import type { LangGraphAnthropicClient } from "./langgraph.tokens";
import { LANGGRAPH_ANTHROPIC_CLIENT } from "./langgraph.tokens";
import { buildResponderSystemPrompt, buildResponderUserContext } from "./prompts/responder.prompt";

@Injectable()
export class LangGraphResponderService {
  private readonly logger = new Logger(LangGraphResponderService.name);
  private static readonly MAX_CONTEXT_FIELD_CHARS = 300;
  private static readonly MAX_DRAFT_CONTEXT_CHARS = 600;
  private static readonly MAX_OPTION_CONTEXT_ITEMS = 5;

  constructor(
    @Inject(LANGGRAPH_ANTHROPIC_CLIENT) private readonly claude: LangGraphAnthropicClient,
  ) {}

  async generateResponse(state: BookingAgentState): Promise<AgentResponse> {
    const deterministicResponse = this.getDeterministicResponse(state);
    if (deterministicResponse) {
      return deterministicResponse;
    }

    const { conversationId, messages, draft, stage, availableOptions, selectedOption } = state;

    try {
      const systemPrompt = buildResponderSystemPrompt(state);
      const userContext = buildResponderUserContext(state, {
        maxContextFieldChars: LangGraphResponderService.MAX_CONTEXT_FIELD_CHARS,
        maxDraftContextChars: LangGraphResponderService.MAX_DRAFT_CONTEXT_CHARS,
        maxOptionContextItems: LangGraphResponderService.MAX_OPTION_CONTEXT_ITEMS,
      });

      this.logger.log("Responder generating response", {
        conversationId,
        stage,
        availableOptionsCount: availableOptions.length,
        availableOptionsList: availableOptions.map(
          (o) => `${o.make} ${o.model} - ₦${o.estimatedTotalInclVat}`,
        ),
        messageCount: messages.length,
        userContextLength: userContext.length,
      });

      this.logger.debug("Responder full user context", {
        conversationId,
        userContext,
      });

      const response = await this.claude.invoke([
        { role: "system", content: systemPrompt },
        ...messages.slice(-6).map((m) => ({
          role: m.role,
          content: m.content,
        })),
        { role: "user", content: userContext },
      ]);

      const content = this.getTextFromClaudeResponse(response.content);

      const interactive = this.determineInteractive(stage, draft, selectedOption, state.error);
      const vehicleCards = this.buildVehicleCards(stage, availableOptions, draft);

      return {
        text: String(content).trim(),
        interactive,
        vehicleCards,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Response generation failed: ${errorMessage}`, errorStack);
      this.logger.debug("Response generation error details", {
        conversationId,
        stage,
        errorType: error instanceof Error ? error.constructor.name : typeof error,
      });
      throw new LangGraphResponseFailedException(
        conversationId,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private getDeterministicResponse(state: BookingAgentState): AgentResponse | null {
    const { extraction, stage, availableOptions, draft, selectedOption, paymentLink, error } =
      state;

    if (extraction?.intent === "reset") {
      return {
        text: "Done — I've cleared your booking details. Ready to start fresh! What do you need?",
      };
    }

    if (error && availableOptions.length === 0 && stage === "collecting") {
      return {
        text: `Unfortunately, ${error}`,
      };
    }

    if (stage === "presenting_options" && availableOptions.length > 0) {
      return {
        text: error
          ? `${error}\n\nHere are your options! Tap Select on the one you'd like to book.`
          : "Here are your options! Tap Select on the one you'd like to book.",
        vehicleCards: this.buildVehicleCards(stage, availableOptions, draft),
      };
    }

    if (stage === "confirming" && selectedOption) {
      if (error) {
        return {
          text: `${error}\n\nWould you like me to try again or connect you to an agent?`,
          interactive: this.determineInteractive(stage, draft, selectedOption, error),
        };
      }

      return {
        text: this.buildBookingSummary(draft, selectedOption),
        interactive: this.determineInteractive(stage, draft, selectedOption, error),
      };
    }

    if (stage === "awaiting_payment" && paymentLink) {
      return {
        text: this.buildPaymentMessage(selectedOption, paymentLink),
      };
    }

    return null;
  }

  private getTextFromClaudeResponse(contentBlock: unknown): string {
    if (typeof contentBlock === "string") {
      return contentBlock;
    }

    if (
      Array.isArray(contentBlock) &&
      contentBlock.length > 0 &&
      typeof contentBlock[0] === "object" &&
      contentBlock[0] !== null &&
      "type" in contentBlock[0] &&
      contentBlock[0].type === "text" &&
      "text" in contentBlock[0]
    ) {
      return String(contentBlock[0].text ?? "");
    }

    return "";
  }

  private buildVehicleCards(
    stage: BookingStage,
    availableOptions: VehicleSearchOption[],
    draft: BookingDraft,
  ): VehicleCard[] | undefined {
    if (stage !== "presenting_options" || availableOptions.length === 0) {
      return undefined;
    }

    return availableOptions.map((opt, index) => {
      const priceFormatted = opt.estimatedTotalInclVat
        ? `₦${opt.estimatedTotalInclVat.toLocaleString()}`
        : "Price on request";

      const caption = this.formatVehicleCaption(opt, index + 1, priceFormatted, draft);
      const buttonTitle = `✓ Select ${opt.make} ${opt.model}`.slice(0, 20);

      return {
        vehicleId: opt.id,
        imageUrl: opt.imageUrl,
        caption,
        buttonId: `select_vehicle:${opt.id}`,
        buttonTitle,
      };
    });
  }

  private formatVehicleCaption(
    opt: VehicleSearchOption,
    index: number,
    priceFormatted: string,
    draft: BookingDraft,
  ): string {
    const bookingTypeLine = draft.bookingType
      ? [`📅 ${this.getBookingTypeLabel(draft.bookingType)}`]
      : [];

    return [
      `*Option ${index}: ${opt.make} ${opt.model}*`,
      ...(opt.color ? [`🎨 Color: ${opt.color}`] : []),
      `🚗 Type: ${opt.vehicleType}`,
      `⭐ Tier: ${opt.serviceTier}`,
      ...bookingTypeLine,
      "",
      `💰 *${priceFormatted} incl. VAT*`,
    ].join("\n");
  }

  private getBookingTypeLabel(bookingType: BookingType): string {
    switch (bookingType) {
      case "DAY":
        return "Day Service (12 hours)";
      case "NIGHT":
        return "Night Service (6 hours)";
      case "FULL_DAY":
        return "Full Day (24 hours)";
      case "AIRPORT_PICKUP":
        return "Airport Pickup";
      default:
        return bookingType;
    }
  }

  private buildBookingSummary(draft: BookingDraft, selectedOption: VehicleSearchOption): string {
    const priceFormatted = selectedOption.estimatedTotalInclVat
      ? `₦${selectedOption.estimatedTotalInclVat.toLocaleString()}`
      : "Price on request";
    const durationDays = this.resolveDurationDays(draft);
    const durationLine =
      durationDays === null
        ? []
        : [`*🗓️ Duration:* ${durationDays} ${durationDays === 1 ? "day" : "days"}`];

    return [
      "*📋 Booking Summary*",
      "",
      `*🚗 Vehicle:* ${selectedOption.make} ${selectedOption.model}`,
      ...(selectedOption.color ? [`*🎨 Color:* ${selectedOption.color}`] : []),
      "",
      ...(draft.bookingType
        ? [`*📅 Service:* ${this.getBookingTypeLabel(draft.bookingType)}`]
        : []),
      ...(draft.pickupDate ? [`*📆 Date:* ${draft.pickupDate}`] : []),
      ...durationLine,
      ...(draft.pickupTime ? [`*⏰ Pickup Time:* ${draft.pickupTime}`] : []),
      ...(draft.pickupLocation ? [`*📍 Pickup:* ${draft.pickupLocation}`] : []),
      ...(draft.dropoffLocation ? [`*📍 Drop-off:* ${draft.dropoffLocation}`] : []),
      "",
      `*💰 Total:* ${priceFormatted} incl. VAT`,
      "",
      "Ready to confirm this booking?",
    ].join("\n");
  }

  private resolveDurationDays(draft: BookingDraft): number | null {
    if (typeof draft.durationDays === "number" && draft.durationDays > 0) {
      return draft.durationDays;
    }

    if (!draft.pickupDate || !draft.dropoffDate) {
      return null;
    }

    const pickupDate = new Date(draft.pickupDate);
    const dropoffDate = new Date(draft.dropoffDate);
    if (Number.isNaN(pickupDate.getTime()) || Number.isNaN(dropoffDate.getTime())) {
      return null;
    }

    const dayDifference = Math.round(
      (dropoffDate.getTime() - pickupDate.getTime()) / (24 * 60 * 60 * 1000),
    );
    if (dayDifference <= 0) {
      return 1;
    }

    return dayDifference;
  }

  private buildPaymentMessage(
    selectedOption: VehicleSearchOption | null,
    _paymentLink: string,
  ): string {
    return [
      "*✅ Booking Created!*",
      "",
      selectedOption
        ? `Your *${selectedOption.make} ${selectedOption.model}* has been reserved.`
        : "Your vehicle has been reserved.",
      "",
      "*Complete your payment to confirm:*",
      "I have sent your secure checkout link below.",
      "",
      "_Your reservation will be held while you complete payment._",
    ].join("\n");
  }

  private determineInteractive(
    stage: BookingAgentState["stage"],
    draft: BookingDraft,
    selectedOption: BookingAgentState["selectedOption"],
    error: string | null = null,
  ): InteractivePayload | undefined {
    if (stage === "confirming" && selectedOption) {
      if (error) {
        return {
          type: "buttons",
          buttons: [
            { id: LANGGRAPH_BUTTON_ID.RETRY_BOOKING, title: "↻ Try Again" },
            { id: LANGGRAPH_BUTTON_ID.SHOW_OTHERS, title: "↻ Show Others" },
            { id: LANGGRAPH_BUTTON_ID.AGENT, title: "💬 Talk to Agent" },
          ],
        };
      }

      return {
        type: "buttons",
        buttons: [
          { id: LANGGRAPH_BUTTON_ID.CONFIRM, title: "✓ Confirm" },
          { id: LANGGRAPH_BUTTON_ID.NO, title: "✕ No" },
          { id: LANGGRAPH_BUTTON_ID.SHOW_OTHERS, title: "↻ Show Others" },
        ],
      };
    }

    if (stage === "awaiting_payment") {
      return {
        type: "buttons",
        buttons: [
          { id: LANGGRAPH_BUTTON_ID.CANCEL, title: "✕ Cancel" },
          { id: LANGGRAPH_BUTTON_ID.AGENT, title: "💬 Talk to Agent" },
        ],
      };
    }

    if (stage === "collecting" && !draft.bookingType) {
      return {
        type: "buttons",
        buttons: [
          { id: LANGGRAPH_BUTTON_ID.DAY, title: "Day (12hrs)" },
          { id: LANGGRAPH_BUTTON_ID.NIGHT, title: "Night (6hrs)" },
          { id: LANGGRAPH_BUTTON_ID.FULL_DAY, title: "Full Day (24hrs)" },
        ],
      };
    }

    return undefined;
  }
}
