import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PinoLogger } from "nestjs-pino";
import type { EnvConfig } from "../../../config/env.config";
import {
  BOOKING_AGENT_DEFAULT_HISTORY_LIMIT,
  BOOKING_AGENT_STATE_TTL_SECONDS,
  buildBookingAgentStateKey,
} from "./conversation.const";
import {
  BookingAgentStateClearFailedException,
  BookingAgentStateLoadFailedException,
  BookingAgentStatePersistFailedException,
} from "./conversation.error";
import type { BookingAgentState, PersistedState } from "./conversation.interface";
import { createDefaultLocationValidationState } from "./conversation.interface";
import type { BookingAgentRedisClient } from "./conversation.tokens";
import { BOOKING_AGENT_REDIS_CLIENT } from "./conversation.tokens";

@Injectable()
export class BookingAgentStateService {
  private readonly historyLimit: number;
  private readonly maxPersistAttempts = 3;
  private readonly persistRetryBaseDelayMs = 100;

  constructor(
    @Inject(BOOKING_AGENT_REDIS_CLIENT) private readonly redis: BookingAgentRedisClient,
    private readonly configService: ConfigService<EnvConfig>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(BookingAgentStateService.name);
    this.historyLimit =
      this.configService.get("BOOKING_AGENT_HISTORY_LIMIT", { infer: true }) ??
      BOOKING_AGENT_DEFAULT_HISTORY_LIMIT;
  }

  async loadState(conversationId: string): Promise<Partial<BookingAgentState> | null> {
    try {
      const key = buildBookingAgentStateKey(conversationId);
      const raw = await this.redis.get(key);

      if (!raw) {
        return null;
      }

      const persisted = JSON.parse(raw) as PersistedState;
      const locationValidation = this.resolvePersistedLocationValidation(persisted);

      return {
        messages: persisted.messages ?? [],
        draft: persisted.draft ?? {},
        stage: persisted.stage ?? "greeting",
        turnCount: persisted.turnCount ?? 0,
        availableOptions: persisted.availableOptions ?? [],
        lastShownOptions: persisted.lastShownOptions ?? [],
        selectedOption: persisted.selectedOption ?? null,
        availableAddons: persisted.availableAddons ?? [],
        selectedAddonIds: persisted.selectedAddonIds ?? [],
        addonSelectionIndex: persisted.addonSelectionIndex ?? 0,
        requiresFullTank: persisted.requiresFullTank ?? false,
        useCredits: persisted.useCredits ?? 0,
        pricingPreview: persisted.pricingPreview ?? null,
        preferences: persisted.preferences ?? {},
        holdId: persisted.holdId ?? null,
        holdExpiresAt: persisted.holdExpiresAt ?? null,
        bookingId: persisted.bookingId ?? null,
        paymentLink: persisted.paymentLink ?? null,
        locationValidation,
      };
    } catch (error) {
      this.logger.error(
        {
          conversationId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to load booking-agent state",
      );
      throw new BookingAgentStateLoadFailedException(conversationId);
    }
  }

  async saveState(conversationId: string, state: BookingAgentState): Promise<void> {
    const key = buildBookingAgentStateKey(conversationId);
    const trimmedMessages = state.messages.slice(-this.historyLimit);

    const persisted: PersistedState = {
      messages: trimmedMessages,
      draft: state.draft,
      stage: state.stage,
      turnCount: state.turnCount,
      availableOptions: state.availableOptions,
      lastShownOptions: state.lastShownOptions,
      selectedOption: state.selectedOption,
      availableAddons: state.availableAddons ?? [],
      selectedAddonIds: state.selectedAddonIds ?? [],
      addonSelectionIndex: state.addonSelectionIndex ?? 0,
      requiresFullTank: state.requiresFullTank ?? false,
      useCredits: state.useCredits ?? 0,
      pricingPreview: state.pricingPreview ?? null,
      preferences: state.preferences,
      holdId: state.holdId,
      holdExpiresAt: state.holdExpiresAt,
      bookingId: state.bookingId,
      paymentLink: state.paymentLink,
      locationValidation: state.locationValidation ?? createDefaultLocationValidationState(),
      updatedAt: new Date().toISOString(),
    };

    for (let attempt = 1; attempt <= this.maxPersistAttempts; attempt += 1) {
      try {
        await this.redis.setex(key, BOOKING_AGENT_STATE_TTL_SECONDS, JSON.stringify(persisted));
        return;
      } catch (error) {
        this.logger.warn(
          {
            conversationId,
            attempt,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to persist booking-agent state",
        );

        if (attempt === this.maxPersistAttempts) {
          throw new BookingAgentStatePersistFailedException(conversationId, attempt);
        }

        await this.sleep(this.persistRetryBaseDelayMs * 2 ** (attempt - 1));
      }
    }
  }

  async clearState(conversationId: string): Promise<void> {
    try {
      const key = buildBookingAgentStateKey(conversationId);
      await this.redis.del(key);
    } catch (error) {
      this.logger.warn(
        {
          conversationId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to clear booking-agent state",
      );
      throw new BookingAgentStateClearFailedException(conversationId);
    }
  }

  createInitialState(
    conversationId: string,
    messageId: string,
    message: string,
    customerId: string | null = null,
  ): BookingAgentState {
    return {
      messages: [],
      conversationId,
      customerId,
      inboundMessage: message,
      inboundMessageId: messageId,
      inboundInteractive: undefined,
      draft: {},
      stage: "greeting",
      turnCount: 0,
      extraction: null,
      availableOptions: [],
      lastShownOptions: [],
      selectedOption: null,
      availableAddons: [],
      selectedAddonIds: [],
      addonSelectionIndex: 0,
      requiresFullTank: false,
      useCredits: 0,
      pricingPreview: null,
      holdId: null,
      holdExpiresAt: null,
      bookingId: null,
      paymentLink: null,
      preferences: {},
      response: null,
      outboxItems: [],
      nextAction: null,
      error: null,
      statusMessage: null,
      locationValidation: createDefaultLocationValidationState(),
    };
  }

  mergeWithExisting(
    existingState: Partial<BookingAgentState>,
    conversationId: string,
    messageId: string,
    message: string,
    customerId: string | null = null,
  ): BookingAgentState {
    return {
      messages: existingState.messages ?? [],
      conversationId,
      customerId,
      inboundMessage: message,
      inboundMessageId: messageId,
      inboundInteractive: undefined,
      draft: existingState.draft ?? {},
      stage: existingState.stage ?? "greeting",
      turnCount: (existingState.turnCount ?? 0) + 1,
      extraction: null,
      availableOptions: existingState.availableOptions ?? [],
      lastShownOptions: existingState.lastShownOptions ?? [],
      selectedOption: existingState.selectedOption ?? null,
      availableAddons: existingState.availableAddons ?? [],
      selectedAddonIds: existingState.selectedAddonIds ?? [],
      addonSelectionIndex: existingState.addonSelectionIndex ?? 0,
      requiresFullTank: existingState.requiresFullTank ?? false,
      useCredits: existingState.useCredits ?? 0,
      pricingPreview: existingState.pricingPreview ?? null,
      holdId: existingState.holdId ?? null,
      holdExpiresAt: existingState.holdExpiresAt ?? null,
      bookingId: existingState.bookingId ?? null,
      paymentLink: existingState.paymentLink ?? null,
      preferences: existingState.preferences ?? {},
      response: null,
      outboxItems: [],
      nextAction: null,
      error: null,
      statusMessage: null,
      locationValidation:
        existingState.locationValidation ?? createDefaultLocationValidationState(),
    };
  }

  private resolvePersistedLocationValidation(
    persisted: PersistedState,
  ): NonNullable<BookingAgentState["locationValidation"]> {
    const defaults = createDefaultLocationValidationState();
    const existing = persisted.locationValidation;
    if (!existing) {
      return defaults;
    }

    return {
      pickup: {
        ...defaults.pickup,
        ...existing.pickup,
      },
      dropoff: {
        ...defaults.dropoff,
        ...existing.dropoff,
      },
    };
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Mutates `BookingAgentState.messages` in-place and trims it to `historyLimit`.
   * Callers should pass a mutable state object and rely on this side effect.
   */
  addMessage(state: BookingAgentState, role: "user" | "assistant", content: string): void {
    state.messages.push({
      role,
      content,
      timestamp: new Date().toISOString(),
    });

    if (state.messages.length > this.historyLimit) {
      state.messages = state.messages.slice(-this.historyLimit);
    }
  }
}
