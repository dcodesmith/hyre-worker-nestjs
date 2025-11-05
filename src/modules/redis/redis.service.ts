import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly redis: Redis;

  constructor(private readonly configService: ConfigService) {
    const redisUrl = this.configService.get<string>("REDIS_URL");

    this.redis = new Redis(redisUrl, {
      maxRetriesPerRequest: null, // Required by BullMQ to prevent blocking operations
      lazyConnect: false, // Connect immediately to avoid delays
      connectTimeout: 10000,
      retryStrategy: (times) => Math.min(times * 200, 2000),
      enableReadyCheck: true,
      enableOfflineQueue: true,
      keepAlive: 30000, // Keep connection alive with 30s heartbeat
    });

    this.redis.on("connect", () => this.logger.log("Redis TCP connected"));
    this.redis.on("ready", () => this.logger.log("Redis client ready"));
    this.redis.on("reconnecting", () => this.logger.warn("Redis reconnecting..."));
    this.redis.on("close", () => this.logger.warn("Redis connection closed"));
    this.redis.on("end", () => this.logger.warn("Redis connection ended"));

    this.redis.on("error", (error: unknown) => {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(`Redis error: ${err.message}`, err.stack);
    });
  }

  async onModuleInit() {
    // Connection already started in constructor due to lazyConnect: false
    // Just verify it's ready
    try {
      await this.redis.ping();
      this.logger.log("Redis connection verified");
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(`Failed to verify Redis connection: ${err.message}`, err.stack);
      throw err;
    }
  }

  getClient(): Redis {
    return this.redis;
  }

  async ping(): Promise<string> {
    const status = this.redis.status;
    this.logger.debug(`Redis status before ping: ${status}`);

    if (status === "end" || status === "close") {
      this.logger.warn(`Redis connection is ${status}, attempting to reconnect...`);
      await this.redis.connect();
    }

    return this.redis.ping();
  }

  async onModuleDestroy() {
    this.logger.log("Disconnecting Redis client...");
    try {
      if (this.redis.status !== "end") {
        await this.redis.quit();
      }
    } catch (error) {
      this.logger.warn("Redis quit failed, forcing disconnect", { error: String(error) });
      this.redis.disconnect(false);
    }
  }
}
