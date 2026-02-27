import { Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import type { ExtractedAiSearchParams } from "../ai-search/ai-search.interface";
import { WHATSAPP_SEARCH_SLOT_TTL_SECONDS } from "./whatsapp-agent.const";
import { WhatsAppSlotMemoryPersistFailedException } from "./whatsapp-agent.error";
import { SearchSlotPayload, SearchSlotSnapshot } from "./whatsapp-agent.interface";
import type { WhatsAppRedisClient } from "./whatsapp-agent.tokens";
import { WHATSAPP_REDIS_CLIENT } from "./whatsapp-agent.tokens";

@Injectable()
export class WhatsAppSearchSlotMemoryService implements OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppSearchSlotMemoryService.name);
  private readonly maxMergeAttempts = 3;

  constructor(@Inject(WHATSAPP_REDIS_CLIENT) private readonly redis: WhatsAppRedisClient) {}

  async mergeWithLatest(
    conversationId: string,
    latest: ExtractedAiSearchParams,
  ): Promise<ExtractedAiSearchParams> {
    for (let attempt = 1; attempt <= this.maxMergeAttempts; attempt += 1) {
      const previous = await this.get(conversationId);
      const merged = this.merge(previous.extracted ?? {}, latest);
      try {
        const persisted = await this.set(conversationId, merged, previous.raw);
        if (persisted) {
          return merged;
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
        return { extracted: null, raw: null };
      }
      try {
        const parsed = JSON.parse(raw) as SearchSlotPayload;
        return { extracted: parsed.extracted ?? null, raw };
      } catch (error) {
        this.logger.warn("Failed to parse search slot memory payload", {
          conversationId,
          error: error instanceof Error ? error.message : String(error),
        });
        return { extracted: null, raw };
      }
    } catch (error) {
      this.logger.warn("Failed to read search slot memory", {
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { extracted: null, raw: null };
    }
  }

  private async set(
    conversationId: string,
    extracted: ExtractedAiSearchParams,
    expectedRaw: string | null,
  ): Promise<boolean> {
    const key = this.buildKey(conversationId);
    const payload: SearchSlotPayload = {
      extracted,
      updatedAt: new Date().toISOString(),
    };
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
        JSON.stringify(payload),
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
    return {
      ...previous,
      ...Object.fromEntries(
        Object.entries(latest).filter(([, value]) => {
          if (typeof value === "string") {
            return value.trim().length > 0;
          }
          return value != null;
        }),
      ),
    };
  }
}
