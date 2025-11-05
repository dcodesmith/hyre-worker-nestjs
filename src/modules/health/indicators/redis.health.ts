import { Injectable } from "@nestjs/common";
import { HealthIndicatorResult, HealthIndicatorService } from "@nestjs/terminus";
import { RedisService } from "../../redis/redis.service";

@Injectable()
export class RedisHealthIndicator {
  constructor(
    private readonly redisService: RedisService,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  async isHealthy(key = "redis"): Promise<HealthIndicatorResult<"redis">> {
    const indicator = this.healthIndicatorService.check(key);
    try {
      const isHealthy = (await this.redisService.ping()) === "PONG";

      if (isHealthy) {
        return indicator.up({ status: "connected" });
      }

      return indicator.down({ status: "disconnected" });
    } catch (error) {
      return indicator.down({
        status: "error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
}
