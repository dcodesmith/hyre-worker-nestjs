import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { type HealthIndicatorResult, HealthIndicatorService } from "@nestjs/terminus";
import Redis from "ioredis";
import { PinoLogger } from "nestjs-pino";
import type { EnvConfig } from "../../config/env.config";

@Injectable()
export class RedisHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    private readonly configService: ConfigService<EnvConfig>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RedisHealthIndicator.name);
  }

  async check(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);
    let redis: Redis | undefined;

    try {
      const redisUrl = this.configService.get("REDIS_URL", { infer: true });
      const url = new URL(redisUrl);
      const isTls = url.protocol === "rediss:";

      redis = new Redis(redisUrl, {
        connectTimeout: 3000,
        commandTimeout: 3000,
        lazyConnect: true,
        ...(isTls && {
          tls: {
            rejectUnauthorized: false,
          },
        }),
      });

      await redis.connect();
      const pong = await redis.ping();

      if (pong !== "PONG") {
        return indicator.down({ message: `Unexpected PING response: ${pong}` });
      }

      return indicator.up();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ error: message }, "Redis health check failed");
      return indicator.down({ message });
    } finally {
      await redis?.quit().catch(() => {});
    }
  }
}
