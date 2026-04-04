import { Inject, Injectable, Logger } from "@nestjs/common";
import { BookingType } from "@prisma/client";
import { addHours, format, isMatch, isValid, parse } from "date-fns";
import { parseSearchDate } from "../vehicle-search-precondition.policy";
import { LANGGRAPH_BUTTON_ID, LANGGRAPH_SERVICE_UNAVAILABLE_MESSAGE } from "./langgraph.const";
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
import { shouldClarifyCancelIntent } from "./langgraph-cancel-clarification.policy";
import { buildResponderSystemPrompt, buildResponderUserContext } from "./prompts/responder.prompt";

@Injectable()
export class LangGraphResponderService {
  private readonly logger = new Logger(LangGraphResponderService.name);
  private static readonly MAX_MESSAGE_HISTORY = 6;
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
        ...messages.slice(-LangGraphResponderService.MAX_MESSAGE_HISTORY).map((m) => ({
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
    const {
      extraction,
      stage,
      availableOptions,
      draft,
      selectedOption,
      paymentLink,
      error,
      statusMessage,
    } = state;

    return (
      this.buildResetResponse(extraction?.intent) ??
      this.buildGreetingErrorResponse(stage, availableOptions, error) ??
      this.buildCollectingStatusResponse(stage, availableOptions, statusMessage) ??
      this.buildPresentingOptionsResponse(stage, availableOptions, statusMessage, draft) ??
      this.buildConfirmingResponse(state, error, draft, selectedOption) ??
      this.buildAwaitingPaymentResponse(stage, paymentLink, selectedOption, draft)
    );
  }

  private buildResetResponse(intent?: string): AgentResponse | null {
    if (intent === "reset") {
      return {
        text: "Done — I've cleared your booking details. Ready to start fresh! What do you need?",
      };
    }
    return null;
  }

  private buildGreetingErrorResponse(
    stage: BookingStage,
    availableOptions: VehicleSearchOption[],
    error: string | null,
  ): AgentResponse | null {
    // Surface user-safe outage messages deterministically in greeting.
    // Keep confirming-stage errors on the confirming path so retry/agent actions are preserved.
    if (
      error &&
      availableOptions.length === 0 &&
      stage === "greeting" &&
      error === LANGGRAPH_SERVICE_UNAVAILABLE_MESSAGE
    ) {
      return { text: error };
    }
    return null;
  }

  private buildCollectingStatusResponse(
    stage: BookingStage,
    availableOptions: VehicleSearchOption[],
    statusMessage: string | null,
  ): AgentResponse | null {
    // Business status updates are scoped to collecting stage without options.
    if (statusMessage && availableOptions.length === 0 && stage === "collecting") {
      return { text: statusMessage };
    }
    return null;
  }

  private buildPresentingOptionsResponse(
    stage: BookingStage,
    availableOptions: VehicleSearchOption[],
    statusMessage: string | null,
    draft: BookingDraft,
  ): AgentResponse | null {
    if (stage !== "presenting_options" || availableOptions.length === 0) {
      return null;
    }

    return {
      text: statusMessage
        ? `${statusMessage}\n\nHere are your options! Tap Select on the one you'd like to book.`
        : "Here are your options! Tap Select on the one you'd like to book.",
      vehicleCards: this.buildVehicleCards(stage, availableOptions, draft),
    };
  }

  private buildConfirmingResponse(
    state: BookingAgentState,
    error: string | null,
    draft: BookingDraft,
    selectedOption: VehicleSearchOption | null,
  ): AgentResponse | null {
    if (state.stage !== "confirming" || !selectedOption) {
      return null;
    }

    if (shouldClarifyCancelIntent(state)) {
      return {
        text: "Do you want to cancel this booking request entirely, or see other car options?",
        interactive: {
          type: "buttons",
          buttons: [
            { id: LANGGRAPH_BUTTON_ID.CANCEL, title: "✕ Cancel Booking" },
            { id: LANGGRAPH_BUTTON_ID.SHOW_OTHERS, title: "↻ Show Others" },
          ],
        },
      };
    }

    if (error) {
      return {
        text: `${error}\n\nWould you like me to try again or connect you to an agent?`,
        interactive: this.determineInteractive(state.stage, draft, selectedOption, error),
      };
    }

    return {
      text: this.buildBookingSummary(draft, selectedOption),
      interactive: this.determineInteractive(state.stage, draft, selectedOption, error),
    };
  }

  private buildAwaitingPaymentResponse(
    stage: BookingStage,
    paymentLink: string | null,
    selectedOption: VehicleSearchOption | null,
    draft: BookingDraft,
  ): AgentResponse | null {
    if (stage === "awaiting_payment" && paymentLink) {
      return {
        text: this.buildPaymentMessage(selectedOption),
        interactive: this.determineInteractive(stage, draft, selectedOption, null),
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
      const priceFormatted = this.formatRequiredPrice(opt.estimatedTotalInclVat);

      const caption = this.formatVehicleCaption(opt, index + 1, priceFormatted, draft);
      const buttonTitle = `✓ Select ${opt.make} ${opt.model}`.slice(0, 20);

      const priceLabel = `${priceFormatted} incl. VAT`;

      return {
        vehicleId: opt.id,
        imageUrl: opt.imageUrl,
        caption,
        priceLabel,
        priceValue: opt.estimatedTotalInclVat,
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
    const priceFormatted = this.formatRequiredPrice(selectedOption.estimatedTotalInclVat);
    const durationDays = this.resolveDurationDays(draft);
    const billedLegs = this.resolveBilledLegs(draft);
    const billedLegUnit = billedLegs === 1 ? "leg" : "legs";
    const bookingWindowLines = this.buildBookingWindowLines(draft);
    const billedLegsSuffix = billedLegs === null ? "" : ` (${billedLegs} billed ${billedLegUnit})`;
    const bookedForUnit = this.resolveBookedForUnit(draft.bookingType);
    const durationLine =
      durationDays === null
        ? []
        : [
            `*🗓️ Booked for:* ${durationDays} ${durationDays === 1 ? bookedForUnit.singular : bookedForUnit.plural}${billedLegsSuffix}`,
          ];

    return [
      "*📋 Booking Summary*",
      "",
      `*🚗 Vehicle:* ${selectedOption.make} ${selectedOption.model}`,
      ...(selectedOption.color ? [`*🎨 Color:* ${selectedOption.color}`] : []),
      "",
      ...(draft.bookingType
        ? [`*📅 Service:* ${this.getBookingTypeLabel(draft.bookingType)}`]
        : []),
      ...bookingWindowLines,
      ...durationLine,
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

  private resolveBilledLegs(draft: BookingDraft): number | null {
    if (typeof draft.durationDays === "number" && draft.durationDays > 0) {
      return draft.durationDays;
    }

    if (draft.bookingType && draft.pickupDate && draft.dropoffDate) {
      const daySpan = this.calculateDateOnlyDaySpan(draft.pickupDate, draft.dropoffDate);
      if (daySpan !== null) {
        switch (draft.bookingType) {
          case "DAY":
            return Math.max(1, daySpan + 1);
          case "NIGHT":
          case "FULL_DAY":
            return Math.max(1, daySpan);
          case "AIRPORT_PICKUP":
            return 1;
          default:
            return null;
        }
      }
    }

    return null;
  }

  private calculateDateOnlyDaySpan(startIsoDate: string, endIsoDate: string): number | null {
    const startUtc = this.parseIsoDateOnlyToUtc(startIsoDate);
    const endUtc = this.parseIsoDateOnlyToUtc(endIsoDate);
    if (startUtc === null || endUtc === null) {
      return null;
    }

    const daySpan = Math.round((endUtc - startUtc) / (24 * 60 * 60 * 1000));
    return Number.isNaN(daySpan) ? null : daySpan;
  }

  private parseIsoDateOnlyToUtc(value: string): number | null {
    const normalized = value.trim();
    if (!isMatch(normalized, "yyyy-MM-dd")) {
      return null;
    }

    const parsedDate = parse(normalized, "yyyy-MM-dd", new Date());
    if (!isValid(parsedDate)) {
      return null;
    }

    const year = parsedDate.getFullYear();
    const month = parsedDate.getMonth() + 1;
    const day = parsedDate.getDate();
    const utcTimestamp = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
    const strictDate = new Date(utcTimestamp);
    if (
      Number.isNaN(strictDate.getTime()) ||
      strictDate.getUTCFullYear() !== year ||
      strictDate.getUTCMonth() !== month - 1 ||
      strictDate.getUTCDate() !== day
    ) {
      return null;
    }

    return utcTimestamp;
  }

  private resolveBookedForUnit(bookingType: BookingType | undefined): {
    singular: string;
    plural: string;
  } {
    if (bookingType === "NIGHT") {
      return { singular: "night", plural: "nights" };
    }
    return { singular: "day", plural: "days" };
  }

  private buildBookingWindowLines(draft: BookingDraft): string[] {
    if (!draft.pickupDate || !draft.pickupTime) {
      return draft.pickupDate ? [`*📆 Date:* ${draft.pickupDate}`] : [];
    }

    const startDate = parseSearchDate(draft.pickupDate);
    if (!startDate) {
      return [`*📆 Date:* ${draft.pickupDate}`, `*⏰ Pickup Time:* ${draft.pickupTime}`];
    }

    const startDateTime = this.withTime(startDate, draft.pickupTime);
    const startLabel = this.formatDateWithAmPm(startDateTime);

    if (!draft.bookingType) {
      return [`*🕐 Start:* ${startLabel}`];
    }

    const dropoffDate = this.resolveDisplayDropoffDate(draft, startDate);
    if (!dropoffDate) {
      return [`*🕐 Start:* ${startLabel}`];
    }

    const endDateTime = this.resolveEndDateTime(dropoffDate, draft.bookingType, draft.pickupTime);
    return [`*🕐 Start:* ${startLabel}`, `*🏁 End:* ${this.formatDateWithAmPm(endDateTime)}`];
  }

  private resolveEndDateTime(date: Date, bookingType: BookingType, pickupTime: string): Date {
    switch (bookingType) {
      case "DAY":
        return addHours(this.withTime(date, pickupTime), 12);
      case "NIGHT":
        return this.withTime(date, "05:00");
      default:
        return this.withTime(date, pickupTime);
    }
  }

  private resolveDisplayDropoffDate(draft: BookingDraft, pickupDate: Date): Date | null {
    if (draft.dropoffDate) {
      return parseSearchDate(draft.dropoffDate);
    }

    if (typeof draft.durationDays !== "number" || draft.durationDays <= 0 || !draft.bookingType) {
      return null;
    }

    const daysToAdd =
      draft.bookingType === "DAY" ? Math.max(draft.durationDays - 1, 0) : draft.durationDays;
    return addHours(pickupDate, daysToAdd * 24);
  }

  private withTime(date: Date, time: string): Date {
    const parsed = this.parseTimeTo24Hour(time);
    if (!parsed) {
      return date;
    }
    return new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      parsed.hours24,
      parsed.minutes,
      0,
      0,
    );
  }

  private parseTimeTo24Hour(time: string): { hours24: number; minutes: number } | null {
    const normalized = time.trim();
    const twelveHourMatch = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i.exec(normalized);
    if (twelveHourMatch) {
      const hour = Number.parseInt(twelveHourMatch[1], 10);
      const minutes = twelveHourMatch[2] ? Number.parseInt(twelveHourMatch[2], 10) : 0;
      if (hour < 1 || hour > 12 || minutes < 0 || minutes > 59) {
        return null;
      }
      let hours24 = hour % 12;
      if (twelveHourMatch[3].toUpperCase() === "PM") {
        hours24 += 12;
      }
      return { hours24, minutes };
    }

    const twentyFourHourMatch = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(normalized);
    if (twentyFourHourMatch) {
      return {
        hours24: Number.parseInt(twentyFourHourMatch[1], 10),
        minutes: Number.parseInt(twentyFourHourMatch[2], 10),
      };
    }

    return null;
  }

  private formatDateWithAmPm(date: Date): string {
    return format(date, "do MMM yyyy, h:mm aaa");
  }

  private formatRequiredPrice(estimatedTotalInclVat: number): string {
    return `₦${estimatedTotalInclVat.toLocaleString()}`;
  }

  private buildPaymentMessage(selectedOption: VehicleSearchOption | null): string {
    return [
      "*✅ Booking Created!*",
      "",
      selectedOption
        ? `Your *${selectedOption.make} ${selectedOption.model}* has been reserved.`
        : "Your vehicle has been reserved.",
      "",
      "*Complete your payment to confirm booking*",
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
