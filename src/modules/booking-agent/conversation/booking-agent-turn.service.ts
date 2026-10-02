import { Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { BookingReservationExpirationService } from "../../payment/booking-reservation-expiration.service";
import { BookingAgentStateService } from "./booking-agent-state.service";
import { BOOKING_AGENT_ACTIONS } from "./conversation.const";
import { BookingAgentExecutionFailedException } from "./conversation.error";
import type {
  BookingAgentState,
  BookingAgentTurnInput,
  BookingAgentTurnResult,
} from "./conversation.interface";
import { CreateBookingAction } from "./create-booking.action";
import { ExtractAction } from "./extract.action";
import { HandoffAction } from "./handoff.action";
import { MergeAction } from "./merge.action";
import { PrepareQuoteAction } from "./prepare-quote.action";
import { RespondAction } from "./respond.action";
import { RouteAction } from "./route.action";
import { SearchAction } from "./search.action";

@Injectable()
export class BookingAgentTurnService {
  constructor(
    private readonly stateService: BookingAgentStateService,
    private readonly bookingReservationExpirationService: BookingReservationExpirationService,
    private readonly extractAction: ExtractAction,
    private readonly mergeAction: MergeAction,
    private readonly routeAction: RouteAction,
    private readonly searchAction: SearchAction,
    private readonly prepareQuoteAction: PrepareQuoteAction,
    private readonly createBookingAction: CreateBookingAction,
    private readonly respondAction: RespondAction,
    private readonly handoffAction: HandoffAction,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(BookingAgentTurnService.name);
  }

  async invoke(input: BookingAgentTurnInput): Promise<BookingAgentTurnResult> {
    const { conversationId, messageId, message, interactive, customerId } = input;

    try {
      const existingState = await this.stateService.loadState(conversationId);

      let state = existingState
        ? this.stateService.mergeWithExisting(
            existingState,
            conversationId,
            messageId,
            message,
            customerId ?? null,
          )
        : this.stateService.createInitialState(
            conversationId,
            messageId,
            message,
            customerId ?? null,
          );

      const stageBeforeHoldCheck = state.stage;
      state = await this.expireElapsedHold(state);

      if (stageBeforeHoldCheck === "awaiting_payment" && state.stage === "completed") {
        this.stateService.addMessage(state, "user", message);
        state = this.applyActionResult(state, await this.respondAction.run(state));
        if (state.response) {
          this.stateService.addMessage(state, "assistant", state.response.text);
        }
        await this.stateService.saveState(conversationId, state);

        const { response, outboxItems, stage, draft, error } = state;
        return { response, outboxItems, stage, draft, error };
      }

      if (interactive) {
        state.inboundInteractive = interactive;
      }

      this.stateService.addMessage(state, "user", message);

      state = this.applyActionResult(state, await this.extractAction.run(state));
      state = this.applyActionResult(state, this.mergeAction.run(state));
      state = this.applyActionResult(state, this.routeAction.run(state));

      switch (state.nextAction) {
        case BOOKING_AGENT_ACTIONS.SEARCH:
          state = this.applyActionResult(state, await this.searchAction.run(state));
          state = this.applyActionResult(state, await this.respondAction.run(state));
          break;
        case BOOKING_AGENT_ACTIONS.CREATE_BOOKING:
          state = this.applyActionResult(state, await this.createBookingAction.run(state));
          state = this.applyActionResult(state, await this.respondAction.run(state));
          break;
        case BOOKING_AGENT_ACTIONS.PREPARE_QUOTE:
          state = this.applyActionResult(state, await this.prepareQuoteAction.run(state));
          state = this.applyActionResult(state, await this.respondAction.run(state));
          break;
        case BOOKING_AGENT_ACTIONS.HANDOFF:
          state = this.applyActionResult(state, this.handoffAction.run(state));
          break;
        default:
          state = this.applyActionResult(state, await this.respondAction.run(state));
      }

      if (state.response) {
        this.stateService.addMessage(state, "assistant", state.response.text);
      }

      await this.stateService.saveState(conversationId, state);

      const { response, outboxItems, stage, draft, error } = state;
      return { response, outboxItems, stage, draft, error };
    } catch (error) {
      this.logger.error(
        {
          conversationId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Booking agent turn execution failed",
      );
      throw new BookingAgentExecutionFailedException(conversationId, "invoke");
    }
  }

  private applyActionResult(
    state: BookingAgentState,
    update: Partial<BookingAgentState>,
  ): BookingAgentState {
    const nextState: BookingAgentState = {
      ...state,
      ...update,
      messages: update.messages ? [...state.messages, ...update.messages] : state.messages,
      draft: update.draft ? this.mergeClearable(state.draft, update.draft) : state.draft,
      preferences: update.preferences
        ? this.mergeClearable(state.preferences, update.preferences)
        : state.preferences,
    };

    if ("turnCount" in update) {
      nextState.turnCount =
        typeof update.turnCount === "number" ? update.turnCount : state.turnCount + 1;
    }

    return nextState;
  }

  private mergeClearable<T extends object>(current: T, update: T & { __clear?: boolean }): T {
    if (update.__clear === true) {
      const { __clear: _clear, ...replacement } = update;
      return replacement as T;
    }

    return { ...current, ...update };
  }

  private async expireElapsedHold(state: BookingAgentState): Promise<BookingAgentState> {
    if (state.stage !== "awaiting_payment" || !state.holdExpiresAt) {
      return state;
    }

    const expiresAt = Date.parse(state.holdExpiresAt);
    if (Number.isNaN(expiresAt) || expiresAt > Date.now()) {
      return state;
    }

    const bookingId = state.bookingId ?? state.holdId;
    if (bookingId) {
      try {
        const outcome =
          await this.bookingReservationExpirationService.reconcileExpiredReservation(bookingId);
        if (outcome === "retained") {
          // Still active, already settled, or payment status is uncertain — leave chat state alone.
          return state;
        }
        if (outcome === "confirmed") {
          return {
            ...state,
            stage: "completed",
            holdId: null,
            holdExpiresAt: null,
            paymentLink: null,
            statusMessage: "Payment confirmed — your booking is confirmed.",
          };
        }
      } catch (error) {
        this.logger.warn(
          {
            bookingId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to reconcile expired WhatsApp booking reservation",
        );
        return state;
      }
    }

    return {
      ...state,
      stage: "confirming",
      holdId: null,
      holdExpiresAt: null,
      bookingId: null,
      paymentLink: null,
      statusMessage:
        "Your previous payment window expired. Please confirm the booking again to generate a new payment link.",
    };
  }
}
