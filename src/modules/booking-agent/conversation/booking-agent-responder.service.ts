import type { Message, MessageCreateParams } from "@anthropic-ai/sdk/resources/messages/messages";
import { Inject, Injectable } from "@nestjs/common";
import { BookingType } from "@prisma/client";
import { addHours, format } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { PinoLogger } from "nestjs-pino";
import {
  getDefaultPickupTime,
  normalizeBookingTimeWindow,
} from "../../../shared/booking-time-window.helper";
import { calculateLegCount } from "../../booking/booking.helper";
import { parseSearchDate } from "../vehicle-search-precondition.policy";
import { shouldClarifyCancelIntent } from "./cancel-clarification.policy";
import {
  BOOKING_AGENT_BUTTON_ID,
  BOOKING_AGENT_MODEL_MAX_RETRIES,
  BOOKING_AGENT_MODEL_TIMEOUT_MS,
  BOOKING_AGENT_RESPONSE_MAX_TOKENS,
  BOOKING_AGENT_RESPONSE_MODEL,
  BOOKING_AGENT_SERVICE_UNAVAILABLE_MESSAGE,
} from "./conversation.const";
import { BookingAgentResponseFailedException } from "./conversation.error";
import type {
  AgentResponse,
  BookingAgentState,
  BookingDraft,
  BookingStage,
  InteractivePayload,
  VehicleCard,
  VehicleSearchOption,
} from "./conversation.interface";
import type { BookingAgentAnthropicClient } from "./conversation.tokens";
import { BOOKING_AGENT_ANTHROPIC_CLIENT } from "./conversation.tokens";
import { buildResponderSystemPrompt, buildResponderUserContext } from "./prompts/responder.prompt";

@Injectable()
export class BookingAgentResponderService {
  private static readonly MAX_MESSAGE_HISTORY = 6;
  private static readonly MAX_CONTEXT_FIELD_CHARS = 300;
  private static readonly MAX_DRAFT_CONTEXT_CHARS = 600;
  private static readonly MAX_OPTION_CONTEXT_ITEMS = 5;

  constructor(
    @Inject(BOOKING_AGENT_ANTHROPIC_CLIENT) private readonly claude: BookingAgentAnthropicClient,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(BookingAgentResponderService.name);
  }

  async generateResponse(state: BookingAgentState): Promise<AgentResponse> {
    const deterministicResponse = this.getDeterministicResponse(state);
    if (deterministicResponse) {
      return deterministicResponse;
    }

    const { conversationId, messages, draft, stage, availableOptions, selectedOption } = state;

    try {
      const systemPrompt = buildResponderSystemPrompt(state);
      const userContext = buildResponderUserContext(state, {
        maxContextFieldChars: BookingAgentResponderService.MAX_CONTEXT_FIELD_CHARS,
        maxDraftContextChars: BookingAgentResponderService.MAX_DRAFT_CONTEXT_CHARS,
        maxOptionContextItems: BookingAgentResponderService.MAX_OPTION_CONTEXT_ITEMS,
      });

      this.logger.info(
        {
          conversationId,
          stage,
          availableOptionsCount: availableOptions.length,
          availableOptionsList: availableOptions.map(
            (o) => `${o.make} ${o.model} - ₦${o.estimatedTotalInclVat}`,
          ),
          messageCount: messages.length,
          userContextLength: userContext.length,
        },
        "Responder generating response",
      );

      this.logger.debug({ conversationId, userContext }, "Responder user context diagnostics");

      const response = await this.claude.messages.create(
        {
          model: BOOKING_AGENT_RESPONSE_MODEL,
          max_tokens: BOOKING_AGENT_RESPONSE_MAX_TOKENS,
          system: systemPrompt,
          thinking: { type: "between_tools" },
          messages: this.buildModelMessages(messages, userContext),
        },
        {
          timeout: BOOKING_AGENT_MODEL_TIMEOUT_MS,
          maxRetries: BOOKING_AGENT_MODEL_MAX_RETRIES,
        },
      );

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
      this.logger.error(
        {
          conversationId,
          error: errorMessage,
          stack: errorStack,
        },
        "Response generation failed",
      );

      throw new BookingAgentResponseFailedException(conversationId);
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
      holdExpiresAt,
      error,
      statusMessage,
    } = state;

    return (
      this.buildResetResponse(extraction?.intent) ??
      this.buildGreetingErrorResponse(stage, error) ??
      this.buildCompletedStatusResponse(stage, statusMessage) ??
      this.buildCollectingStatusResponse(stage, availableOptions, statusMessage) ??
      this.buildPresentingOptionsResponse(stage, availableOptions, statusMessage, draft) ??
      this.buildAddonSelectionResponse(state) ??
      this.buildFuelSelectionResponse(state) ??
      this.buildCreditsSelectionResponse(state) ??
      this.buildConfirmingResponse(state, error, draft, selectedOption) ??
      this.buildAwaitingPaymentResponse(stage, paymentLink, holdExpiresAt, selectedOption, draft)
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
    error: string | null,
  ): AgentResponse | null {
    // Surface user-safe outage messages deterministically in greeting.
    // Keep confirming-stage errors on the confirming path so retry/agent actions are preserved.
    // Do not require empty options — extract failures preserve draft/options by design.
    if (error === BOOKING_AGENT_SERVICE_UNAVAILABLE_MESSAGE && stage === "greeting") {
      return { text: error };
    }
    return null;
  }

  private buildCompletedStatusResponse(
    stage: BookingStage,
    statusMessage: string | null,
  ): AgentResponse | null {
    if (stage === "completed" && statusMessage) {
      return { text: statusMessage };
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
            { id: BOOKING_AGENT_BUTTON_ID.CANCEL, title: "✕ Cancel Booking" },
            { id: BOOKING_AGENT_BUTTON_ID.SHOW_OTHERS, title: "↻ Show Others" },
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

    const summary = state.pricingPreview
      ? this.buildFinalBookingSummary(state)
      : this.buildBookingSummary(draft, selectedOption);
    return {
      text: state.statusMessage ? `${state.statusMessage}\n\n${summary}` : summary,
      interactive: this.determineInteractive(state.stage, draft, selectedOption, error),
    };
  }

  private buildAddonSelectionResponse(state: BookingAgentState): AgentResponse | null {
    if (state.stage !== "selecting_addons") {
      return null;
    }
    const addon = (state.availableAddons ?? [])[state.addonSelectionIndex ?? 0];
    if (!addon) {
      return { text: "I'm preparing your final quote." };
    }

    const unitLabel = addon.pricingUnit === "PER_LEG" ? "per booking leg" : "per booking";
    return {
      text: [
        `Would you like to add *${addon.name}* for *${this.formatMoney(addon.unitPrice)} ${unitLabel}*?`,
        ...(addon.description ? [addon.description] : []),
      ].join("\n"),
      interactive: {
        type: "buttons",
        buttons: [
          { id: `addon_add:${addon.id}`, title: "✓ Add" },
          { id: `addon_skip:${addon.id}`, title: "Skip" },
          { id: BOOKING_AGENT_BUTTON_ID.ADDON_SKIP_ALL, title: "Skip All" },
        ],
      },
    };
  }

  private buildFuelSelectionResponse(state: BookingAgentState): AgentResponse | null {
    if (state.stage !== "selecting_fuel" || !state.pricingPreview) {
      return null;
    }
    return {
      text: `Would you like the fuel upgrade for *${this.formatMoney(state.pricingPreview.fuelUpgradeCost)}*?`,
      interactive: {
        type: "buttons",
        buttons: [
          { id: BOOKING_AGENT_BUTTON_ID.FUEL_APPLY, title: "APPLY" },
          { id: BOOKING_AGENT_BUTTON_ID.FUEL_SKIP, title: "SKIP" },
        ],
      },
    };
  }

  private buildCreditsSelectionResponse(state: BookingAgentState): AgentResponse | null {
    if (state.stage !== "selecting_credits" || !state.pricingPreview) {
      return null;
    }
    return {
      text: `You can apply *${this.formatMoney(state.pricingPreview.creditsApplicable)}* in credits. Apply them to this booking?`,
      interactive: {
        type: "buttons",
        buttons: [
          { id: BOOKING_AGENT_BUTTON_ID.CREDITS_APPLY, title: "APPLY" },
          { id: BOOKING_AGENT_BUTTON_ID.CREDITS_SKIP, title: "SKIP" },
        ],
      },
    };
  }

  private buildAwaitingPaymentResponse(
    stage: BookingStage,
    paymentLink: string | null,
    holdExpiresAt: string | null,
    selectedOption: VehicleSearchOption | null,
    draft: BookingDraft,
  ): AgentResponse | null {
    if (stage === "awaiting_payment" && paymentLink) {
      return {
        text: this.buildPaymentMessage(selectedOption, holdExpiresAt),
        interactive: this.determineInteractive(stage, draft, selectedOption, null),
      };
    }
    return null;
  }

  private buildModelMessages(
    messages: BookingAgentState["messages"],
    userContext: string,
  ): MessageCreateParams["messages"] {
    const pending = [
      ...messages
        .slice(-BookingAgentResponderService.MAX_MESSAGE_HISTORY)
        .map((message) => ({ role: message.role, content: message.content })),
      { role: "user" as const, content: userContext },
    ];
    const merged: MessageCreateParams["messages"] = [];

    for (const message of pending) {
      const previous = merged.at(-1);
      if (previous && previous.role === message.role && typeof previous.content === "string") {
        previous.content = `${previous.content}\n${message.content}`;
        continue;
      }
      merged.push(message);
    }

    return merged;
  }

  private getTextFromClaudeResponse(content: Message["content"]): string {
    const textBlock = content.find((block) => block.type === "text");
    return textBlock?.type === "text" ? textBlock.text : "";
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
    const bookingWindowLines = this.buildBookingWindowLines(draft);
    const bookedForUnit = this.resolveBookedForUnit(draft.bookingType);
    const durationLine =
      durationDays === null
        ? []
        : [
            `*🗓️ Booked for:* ${durationDays} ${durationDays === 1 ? bookedForUnit.singular : bookedForUnit.plural}`,
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

  private buildFinalBookingSummary(state: BookingAgentState): string {
    const selectedOption = state.selectedOption;
    const pricing = state.pricingPreview;
    if (!selectedOption || !pricing) {
      return "Please review and confirm your booking.";
    }

    const addonLines = pricing.addons.map(
      (addon) => `• ${addon.name}: ${this.formatMoney(addon.totalPrice)}`,
    );
    const adjustmentLines = [
      ...(pricing.fuelUpgradeCost > 0
        ? [`• Fuel upgrade: ${this.formatMoney(pricing.fuelUpgradeCost)}`]
        : []),
      ...(pricing.platformFeeAmount > 0
        ? [`• Service fee: ${this.formatMoney(pricing.platformFeeAmount)}`]
        : []),
      ...(pricing.referralDiscountAmount > 0
        ? [`• Referral discount: -${this.formatMoney(pricing.referralDiscountAmount)}`]
        : []),
      ...(pricing.creditsUsed > 0
        ? [`• Credits applied: -${this.formatMoney(pricing.creditsUsed)}`]
        : []),
    ];

    return [
      "*📋 Final Booking Quote*",
      "",
      `*🚗 Vehicle:* ${selectedOption.make} ${selectedOption.model}`,
      ...(state.draft.bookingType
        ? [`*📅 Service:* ${this.getBookingTypeLabel(state.draft.bookingType)}`]
        : []),
      ...this.buildBookingWindowLines(state.draft),
      ...(state.draft.pickupLocation ? [`*📍 Pickup:* ${state.draft.pickupLocation}`] : []),
      ...(state.draft.dropoffLocation ? [`*📍 Drop-off:* ${state.draft.dropoffLocation}`] : []),
      "",
      `• Base: ${this.formatMoney(pricing.baseTotal)}`,
      ...addonLines,
      ...adjustmentLines,
      `• VAT: ${this.formatMoney(pricing.vatAmount)}`,
      `*💰 Total: ${this.formatMoney(pricing.totalAmount)}*`,
      "",
      "Ready to confirm this booking?",
    ].join("\n");
  }

  private resolveDurationDays(draft: BookingDraft): number | null {
    if (typeof draft.durationDays === "number" && draft.durationDays > 0) {
      return draft.durationDays;
    }

    const derivedDuration = this.resolveDurationFromCanonicalLegCount(draft);
    if (derivedDuration !== null) {
      return derivedDuration;
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

  private resolveDurationFromCanonicalLegCount(draft: BookingDraft): number | null {
    if (!draft.bookingType || !draft.pickupDate || !draft.dropoffDate) {
      return null;
    }

    const pickupDate = parseSearchDate(draft.pickupDate);
    const dropoffDate = parseSearchDate(draft.dropoffDate);
    if (!pickupDate || !dropoffDate) {
      return null;
    }

    const pickupTime = draft.pickupTime ?? getDefaultPickupTime(draft.bookingType);
    const { startDate, endDate } = normalizeBookingTimeWindow({
      bookingType: draft.bookingType,
      startDate: pickupDate,
      endDate: dropoffDate,
      pickupTime,
    });

    return calculateLegCount(draft.bookingType, startDate, endDate);
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

  private formatMoney(amount: number): string {
    return `₦${amount.toLocaleString("en-NG")}`;
  }

  private buildPaymentMessage(
    selectedOption: VehicleSearchOption | null,
    holdExpiresAt: string | null,
  ): string {
    const reservationLine = this.buildReservationExpiryLine(holdExpiresAt);
    return [
      "*✅ Booking Created!*",
      "",
      selectedOption
        ? `Your booking includes the *${selectedOption.make} ${selectedOption.model}*.`
        : "Your vehicle selection has been added to the booking.",
      "",
      ...(reservationLine ? [reservationLine, ""] : []),
      "*Complete your payment to confirm booking*",
    ].join("\n");
  }

  private buildReservationExpiryLine(holdExpiresAt: string | null): string | null {
    if (!holdExpiresAt) {
      return null;
    }

    const expiry = new Date(holdExpiresAt);
    if (Number.isNaN(expiry.getTime())) {
      return null;
    }

    const friendlyExpiry = formatInTimeZone(expiry, "Africa/Lagos", "do MMM yyyy 'at' h:mm aaa");
    return `Your vehicle is reserved until *${friendlyExpiry} (Lagos time)*. Please pay before then.`;
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
            { id: BOOKING_AGENT_BUTTON_ID.RETRY_BOOKING, title: "↻ Try Again" },
            { id: BOOKING_AGENT_BUTTON_ID.SHOW_OTHERS, title: "↻ Show Others" },
            { id: BOOKING_AGENT_BUTTON_ID.AGENT, title: "💬 Talk to Agent" },
          ],
        };
      }

      return {
        type: "buttons",
        buttons: [
          { id: BOOKING_AGENT_BUTTON_ID.CONFIRM, title: "✓ Confirm" },
          { id: BOOKING_AGENT_BUTTON_ID.NO, title: "✕ No" },
          { id: BOOKING_AGENT_BUTTON_ID.SHOW_OTHERS, title: "↻ Show Others" },
        ],
      };
    }

    if (stage === "awaiting_payment") {
      return {
        type: "buttons",
        buttons: [
          { id: BOOKING_AGENT_BUTTON_ID.CANCEL, title: "✕ Cancel" },
          { id: BOOKING_AGENT_BUTTON_ID.AGENT, title: "💬 Talk to Agent" },
        ],
      };
    }

    if (stage === "collecting" && !draft.bookingType) {
      return {
        type: "buttons",
        buttons: [
          { id: BOOKING_AGENT_BUTTON_ID.DAY, title: "Day (12hrs)" },
          { id: BOOKING_AGENT_BUTTON_ID.NIGHT, title: "Night (6hrs)" },
          { id: BOOKING_AGENT_BUTTON_ID.FULL_DAY, title: "Full Day (24hrs)" },
        ],
      };
    }

    return undefined;
  }
}
