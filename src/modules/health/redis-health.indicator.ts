import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { type HealthIndicatorResult, HealthIndicatorService } from "@nestjs/terminus";
import Redis from "ioredis";
import type { EnvConfig } from "../../config/env.config";

@Injectable()
export class RedisHealthIndicator {
  private readonly logger = new Logger(RedisHealthIndicator.name);

  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    private readonly configService: ConfigService<EnvConfig>,
  ) {}

  async check(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);
    let redis: Redis | undefined;

    try {
      const redisUrl = this.configService.get("REDIS_URL", { infer: true });
      redis = new Redis(redisUrl, {
        connectTimeout: 3000,
        lazyConnect: true,
      });

      await redis.connect();
      const pong = await redis.ping();

      if (pong !== "PONG") {
        return indicator.down({ message: `Unexpected PING response: ${pong}` });
      }

      return indicator.up();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Redis health check failed: ${message}`);
      return indicator.down({ message });
    } finally {
      await redis?.quit().catch(() => {});
    }
  }
}
