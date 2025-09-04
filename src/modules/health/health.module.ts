import { BullModule } from "@nestjs/bull";
import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { RedisModule } from "../redis/redis.module";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";

@Module({
  imports: [
    DatabaseModule,
    RedisModule,
    BullModule.registerQueue({ name: "reminder-emails" }),
    BullModule.registerQueue({ name: "status-updates" }),
    BullModule.registerQueue({ name: "notifications" }),
  ],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
