import { Module } from "@nestjs/common";
import { TerminusModule } from "@nestjs/terminus";
import { DatabaseModule } from "../database/database.module";
import { RedisModule } from "../redis/redis.module";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";
import { RedisHealthIndicator } from "./indicators/redis.health";

@Module({
  imports: [TerminusModule, DatabaseModule, RedisModule],
  controllers: [HealthController],
  providers: [HealthService, RedisHealthIndicator],
})
export class HealthModule {}
