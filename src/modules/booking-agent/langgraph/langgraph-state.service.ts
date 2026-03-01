import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { EnvConfig } from "../../../config/env.config";
import {
  buildLangGraphStateKey,
  LANGGRAPH_DEFAULT_HISTORY_LIMIT,
  LANGGRAPH_STATE_TTL_SECONDS,
} from "./langgraph.const";
import {
  LangGraphStateLoadFailedException,
  LangGraphStatePersistFailedException,
} from "./langgraph.error";
import type { BookingAgentState, PersistedState } from "./langgraph.interface";
import type { LangGraphRedisClient } from "./langgraph.tokens";
import { LANGGRAPH_REDIS_CLIENT } from "./langgraph.tokens";

@Injectable()
export class LangGraphStateService {
  private readonly logger = new Logger(LangGraphStateService.name);
  private readonly historyLimit: number;
  private readonly maxPersistAttempts = 3;

  constructor(
    @Inject(LANGGRAPH_REDIS_CLIENT) private readonly redis: LangGraphRedisClient,
    private readonly configService: ConfigService<EnvConfig>,
  ) {
    this.historyLimit =
      this.configService.get("LANGGRAPH_HISTORY_LIMIT", { infer: true }) ??
      LANGGRAPH_DEFAULT_HISTORY_LIMIT;
  }

  async loadState(conversationId: string): Promise<Partial<BookingAgentState> | null> {
    try {
      const key = buildLangGraphStateKey(conversationId);
      const raw = await this.redis.get(key);

      if (!raw) {
        return null;
      }

      const persisted = JSON.parse(raw) as PersistedState;

      return {
        messages: persisted.messages ?? [],
        draft: persisted.draft ?? {},
        stage: persisted.stage ?? "greeting",
        turnCount: persisted.turnCount ?? 0,
        availableOptions: persisted.availableOptions ?? [],
        lastShownOptions: persisted.lastShownOptions ?? [],
        selectedOption: persisted.selectedOption ?? null,
        preferences: persisted.preferences ?? {},
        holdId: persisted.holdId ?? null,
        holdExpiresAt: persisted.holdExpiresAt ?? null,
        bookingId: persisted.bookingId ?? null,
      };
    } catch (error) {
      this.logger.error("Failed to load LangGraph state", {
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new LangGraphStateLoadFailedException(
        conversationId,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async saveState(conversationId: string, state: BookingAgentState): Promise<void> {
    const key = buildLangGraphStateKey(conversationId);
    const trimmedMessages = state.messages.slice(-this.historyLimit);

    const persisted: PersistedState = {
      messages: trimmedMessages,
      draft: state.draft,
      stage: state.stage,
      turnCount: state.turnCount,
      availableOptions: state.availableOptions,
      lastShownOptions: state.lastShownOptions,
      selectedOption: state.selectedOption,
      preferences: state.preferences,
      holdId: state.holdId,
      holdExpiresAt: state.holdExpiresAt,
      bookingId: state.bookingId,
      updatedAt: new Date().toISOString(),
    };

    for (let attempt = 1; attempt <= this.maxPersistAttempts; attempt += 1) {
      try {
        await this.redis.setex(key, LANGGRAPH_STATE_TTL_SECONDS, JSON.stringify(persisted));
        return;
      } catch (error) {
        this.logger.warn("Failed to persist LangGraph state", {
          conversationId,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });

        if (attempt === this.maxPersistAttempts) {
          throw new LangGraphStatePersistFailedException(conversationId, attempt);
        }
      }
    }
  }

  async clearState(conversationId: string): Promise<void> {
    try {
      const key = buildLangGraphStateKey(conversationId);
      await this.redis.del(key);
    } catch (error) {
      this.logger.warn("Failed to clear LangGraph state", {
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
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
      holdId: null,
      holdExpiresAt: null,
      bookingId: null,
      paymentLink: null,
      preferences: {},
      response: null,
      outboxItems: [],
      nextNode: null,
      error: null,
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
      holdId: existingState.holdId ?? null,
      holdExpiresAt: existingState.holdExpiresAt ?? null,
      bookingId: existingState.bookingId ?? null,
      paymentLink: null,
      preferences: existingState.preferences ?? {},
      response: null,
      outboxItems: [],
      nextNode: null,
      error: null,
    };
  }

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
