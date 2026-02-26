import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import type { EnvConfig } from "../../config/env.config";
import type { ExtractedAiSearchParams } from "../ai-search/ai-search.interface";
import { WHATSAPP_SEARCH_SLOT_TTL_SECONDS } from "./whatsapp-agent.const";

interface SearchSlotPayload {
  extracted: ExtractedAiSearchParams;
  updatedAt: string;
}

@Injectable()
export class WhatsAppSearchSlotMemoryService implements OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppSearchSlotMemoryService.name);
  private readonly redis: Redis;

  constructor(private readonly configService: ConfigService<EnvConfig>) {
    const redisUrl = this.configService.get("REDIS_URL", { infer: true });
    this.redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
    });
  }

  async mergeWithLatest(
    conversationId: string,
    latest: ExtractedAiSearchParams,
  ): Promise<ExtractedAiSearchParams> {
    const previous = await this.get(conversationId);
    const merged = this.merge(previous ?? {}, latest);
    try {
      await this.set(conversationId, merged);
      return merged;
    } catch (error) {
      this.logger.warn("Failed to persist merged search slot memory", {
        conversationId,
        merged: "[REDACTED]",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
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

  private async get(conversationId: string): Promise<ExtractedAiSearchParams | null> {
    try {
      const raw = await this.redis.get(this.buildKey(conversationId));
      if (!raw) {
        return null;
      }
      try {
        const parsed = JSON.parse(raw) as SearchSlotPayload;
        return parsed.extracted ?? null;
      } catch (error) {
        this.logger.warn("Failed to parse search slot memory payload", {
          conversationId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    } catch (error) {
      this.logger.warn("Failed to read search slot memory", {
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async set(conversationId: string, extracted: ExtractedAiSearchParams): Promise<void> {
    const payload: SearchSlotPayload = {
      extracted,
      updatedAt: new Date().toISOString(),
    };
    try {
      await this.redis.set(
        this.buildKey(conversationId),
        JSON.stringify(payload),
        "EX",
        WHATSAPP_SEARCH_SLOT_TTL_SECONDS,
      );
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
