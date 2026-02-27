import { Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import type { ExtractedAiSearchParams } from "../ai-search/ai-search.interface";
import {
  WHATSAPP_SEARCH_SLOT_FRESH_INTENT_WINDOW_SECONDS,
  WHATSAPP_SEARCH_SLOT_TTL_SECONDS,
} from "./whatsapp-agent.const";
import { WhatsAppSlotMemoryPersistFailedException } from "./whatsapp-agent.error";
import {
  SearchDialogState,
  SearchQuestionType,
  SearchSlotMergeResult,
  SearchSlotPayload,
  SearchSlotSnapshot,
} from "./whatsapp-agent.interface";
import type { WhatsAppRedisClient } from "./whatsapp-agent.tokens";
import { WHATSAPP_REDIS_CLIENT } from "./whatsapp-agent.tokens";

@Injectable()
export class WhatsAppSearchSlotMemoryService implements OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppSearchSlotMemoryService.name);
  private readonly maxMergeAttempts = 3;
  private readonly freshIntentWindowMs = WHATSAPP_SEARCH_SLOT_FRESH_INTENT_WINDOW_SECONDS * 1000;

  constructor(@Inject(WHATSAPP_REDIS_CLIENT) private readonly redis: WhatsAppRedisClient) {}

  async mergeWithLatest(
    conversationId: string,
    latest: ExtractedAiSearchParams,
  ): Promise<SearchSlotMergeResult> {
    for (let attempt = 1; attempt <= this.maxMergeAttempts; attempt += 1) {
      const previous = await this.get(conversationId);
      const normalizedLatest = this.normalize(latest);
      const merged = this.shouldStartFreshIntent(previous, normalizedLatest)
        ? normalizedLatest
        : this.merge(previous.extracted ?? {}, normalizedLatest);
      const dialogState = this.mergeDialogState(
        previous.dialogState,
        previous.extracted ?? {},
        merged,
        normalizedLatest,
      );
      try {
        const persisted = await this.set(conversationId, merged, dialogState, previous.raw);
        if (persisted) {
          return { extracted: merged, dialogState };
        }
      } catch (error) {
        this.logger.warn("Failed to persist merged search slot memory", {
          conversationId,
          merged: "[REDACTED]",
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    throw new WhatsAppSlotMemoryPersistFailedException(conversationId, this.maxMergeAttempts);
  }

  async recordQuestionAsked(
    conversationId: string,
    questionType: SearchQuestionType,
  ): Promise<void> {
    await this.updateDialogState(conversationId, (current) => ({
      ...current,
      lastAskedQuestionType: questionType,
      lastAskedAt: new Date().toISOString(),
    }));
  }

  async clearAskedQuestion(conversationId: string): Promise<void> {
    await this.updateDialogState(conversationId, (current) => {
      if (current.lastAskedQuestionType == null && current.lastAskedAt == null) {
        return current;
      }
      return {
        ...current,
        lastAskedQuestionType: null,
        lastAskedAt: null,
      };
    });
  }

  async clear(conversationId: string): Promise<void> {
    try {
      await this.redis.del(this.buildKey(conversationId));
    } catch (error) {
      this.logger.warn("Failed to clear search slot memory", {
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }

  private async get(conversationId: string): Promise<SearchSlotSnapshot> {
    try {
      const raw = await this.redis.get(this.buildKey(conversationId));
      if (!raw) {
        return {
          extracted: null,
          dialogState: this.defaultDialogState(),
          updatedAt: null,
          raw: null,
        };
      }
      try {
        const parsed = JSON.parse(raw) as SearchSlotPayload;
        return {
          extracted: parsed.extracted ?? null,
          dialogState: this.normalizeDialogState(parsed.dialogState),
          updatedAt: parsed.updatedAt ?? null,
          raw,
        };
      } catch (error) {
        this.logger.warn("Failed to parse search slot memory payload", {
          conversationId,
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          extracted: null,
          dialogState: this.defaultDialogState(),
          updatedAt: null,
          raw,
        };
      }
    } catch (error) {
      this.logger.warn("Failed to read search slot memory", {
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        extracted: null,
        dialogState: this.defaultDialogState(),
        updatedAt: null,
        raw: null,
      };
    }
  }

  private async set(
    conversationId: string,
    extracted: ExtractedAiSearchParams,
    dialogState: SearchDialogState,
    expectedRaw: string | null,
  ): Promise<boolean> {
    const key = this.buildKey(conversationId);
    const payload: SearchSlotPayload = {
      extracted,
      dialogState,
      updatedAt: new Date().toISOString(),
    };
    const nextRaw = JSON.stringify(payload);
    if (expectedRaw === nextRaw) {
      return true;
    }
    const expectedRawArg = expectedRaw ?? "__NULL__";
    const compareAndSetScript = `
      local current = redis.call("GET", KEYS[1])
      local expected = ARGV[1]

      if expected == "__NULL__" then
        if current ~= false then
          return 0
        end
      else
        if current ~= expected then
          return 0
        end
      end

      redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3])
      return 1
    `;
    try {
      const evalResult = await this.redis.eval(
        compareAndSetScript,
        1,
        key,
        expectedRawArg,
        nextRaw,
        String(WHATSAPP_SEARCH_SLOT_TTL_SECONDS),
      );
      return evalResult === 1;
    } catch (error) {
      this.logger.warn("Failed to write search slot memory", {
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private buildKey(conversationId: string): string {
    return `whatsapp:search-slots:${conversationId}`;
  }

  private merge(
    previous: ExtractedAiSearchParams,
    latest: ExtractedAiSearchParams,
  ): ExtractedAiSearchParams {
    const merged = {
      ...previous,
      ...latest,
    };

    if (
      latest.make &&
      previous.make &&
      latest.make.trim().toLowerCase() !== previous.make.trim().toLowerCase()
    ) {
      delete merged.model;
    }

    if (latest.make && latest.vehicleType && !latest.model) {
      delete merged.model;
    }

    if (latest.vehicleType && previous.vehicleType && latest.vehicleType !== previous.vehicleType) {
      delete merged.model;
    }

    return merged;
  }

  private normalize(input: ExtractedAiSearchParams): ExtractedAiSearchParams {
    return Object.fromEntries(
      Object.entries(input).filter(([, value]) => {
        if (typeof value === "string") {
          return value.trim().length > 0;
        }
        return value != null;
      }),
    ) as ExtractedAiSearchParams;
  }

  private defaultDialogState(): SearchDialogState {
    return {
      bookingTypeConfirmed: false,
      lastAskedQuestionType: null,
      lastAskedAt: null,
    };
  }

  private normalizeDialogState(input: SearchDialogState | undefined): SearchDialogState {
    if (!input) {
      return this.defaultDialogState();
    }
    return {
      bookingTypeConfirmed: Boolean(input.bookingTypeConfirmed),
      lastAskedQuestionType: input.lastAskedQuestionType ?? null,
      lastAskedAt: input.lastAskedAt ?? null,
    };
  }

  private mergeDialogState(
    previousState: SearchDialogState,
    previousExtracted: ExtractedAiSearchParams,
    mergedExtracted: ExtractedAiSearchParams,
    latestExtracted: ExtractedAiSearchParams,
  ): SearchDialogState {
    const contextChanged = this.hasCoreContextChange(previousExtracted, mergedExtracted);
    const baseState: SearchDialogState = contextChanged
      ? {
          bookingTypeConfirmed: false,
          lastAskedQuestionType: null,
          lastAskedAt: null,
        }
      : previousState;

    if (latestExtracted.bookingType) {
      return {
        ...baseState,
        bookingTypeConfirmed: true,
      };
    }

    return baseState;
  }

  private hasCoreContextChange(
    previous: ExtractedAiSearchParams,
    current: ExtractedAiSearchParams,
  ): boolean {
    const fields: Array<keyof ExtractedAiSearchParams> = [
      "make",
      "model",
      "vehicleType",
      "serviceTier",
      "color",
      "from",
      "to",
      "pickupLocation",
      "dropoffLocation",
      "pickupTime",
    ];
    return fields.some((field) => {
      const prevValue = previous[field];
      const currentValue = current[field];
      if (typeof prevValue === "string" || typeof currentValue === "string") {
        return (prevValue ?? "").toString().trim() !== (currentValue ?? "").toString().trim();
      }
      return prevValue !== currentValue;
    });
  }

  private shouldStartFreshIntent(
    previous: SearchSlotSnapshot,
    latest: ExtractedAiSearchParams,
  ): boolean {
    if (this.isExpired(previous.updatedAt)) {
      return true;
    }
    return this.isCompleteIntent(latest);
  }

  private isExpired(updatedAt: string | null): boolean {
    if (!updatedAt) {
      return false;
    }
    const updatedMs = Date.parse(updatedAt);
    if (Number.isNaN(updatedMs)) {
      this.logger.warn("Invalid search slot updatedAt timestamp; treating as non-expired", {
        service: WhatsAppSearchSlotMemoryService.name,
        updatedAt,
      });
      return false;
    }
    return Date.now() - updatedMs > this.freshIntentWindowMs;
  }

  private isCompleteIntent(latest: ExtractedAiSearchParams): boolean {
    const hasVehicleSignal = Boolean(
      latest.make || latest.model || latest.vehicleType || latest.color,
    );
    return Boolean(
      hasVehicleSignal &&
        latest.from &&
        latest.bookingType &&
        latest.pickupLocation &&
        latest.dropoffLocation,
    );
  }

  private async updateDialogState(
    conversationId: string,
    mutate: (current: SearchDialogState) => SearchDialogState,
  ): Promise<void> {
    for (let attempt = 1; attempt <= this.maxMergeAttempts; attempt += 1) {
      const snapshot = await this.get(conversationId);
      const nextDialogState = this.normalizeDialogState(mutate(snapshot.dialogState));
      try {
        const persisted = await this.set(
          conversationId,
          snapshot.extracted ?? {},
          nextDialogState,
          snapshot.raw,
        );
        if (persisted) {
          return;
        }
      } catch (error) {
        this.logger.warn("Failed to persist updated search dialog state", {
          conversationId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
    throw new WhatsAppSlotMemoryPersistFailedException(conversationId, this.maxMergeAttempts);
  }
}
