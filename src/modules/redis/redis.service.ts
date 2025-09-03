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
      family: 6, // Force IPv6
      maxRetriesPerRequest: null, // Required by BullMQ to prevent blocking operations
      lazyConnect: true, // Connect only when needed
      connectTimeout: 10000,
      retryStrategy: (times) => Math.min(times * 200, 2000),
    });

    this.redis.on("connect", () => {
      this.logger.log("Redis connected successfully");
    });

    this.redis.on("error", (error) => {
      this.logger.error("Redis connection error:", error);
    });
  }

  async onModuleInit() {
    try {
      await this.redis.connect();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(`Failed to connect to Redis on startup: ${err.message}`, err.stack);
      throw err;
    }
  }

  getClient(): Redis {
    return this.redis;
  }

  async ping(): Promise<string> {
    return this.redis.ping();
  }

  async onModuleDestroy() {
    this.logger.log("Disconnecting Redis client...");
    try {
      await this.redis.quit();
    } catch (error) {
      this.logger.warn("Redis quit failed, forcing disconnect", { error: String(error) });
      this.redis.disconnect(false);
    }
  }
}
