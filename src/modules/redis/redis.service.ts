import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly redis: Redis;

  constructor(private readonly configService: ConfigService) {
    const redisUrl = this.configService.get<string>("REDIS_URL");

    this.redis = new Redis(redisUrl, {
      family: 6, // Force IPv6
      maxRetriesPerRequest: null, // Required by BullMQ to prevent blocking operations
      lazyConnect: true, // Connect only when needed
    });

    this.redis.on("connect", () => {
      this.logger.log("Redis connected successfully");
    });

    this.redis.on("error", (error) => {
      this.logger.error("Redis connection error:", error);
    });
  }

  getClient(): Redis {
    return this.redis;
  }

  async ping(): Promise<string> {
    return this.redis.ping();
  }

  async onModuleDestroy() {
    this.logger.log("Disconnecting Redis client...");
    await this.redis.quit();
  }
}
