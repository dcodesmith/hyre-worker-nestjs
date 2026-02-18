import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { ThrottlerModule } from "@nestjs/throttler";
import { REFERRAL_QUEUE } from "../../config/constants";
import { AuthModule } from "../auth/auth.module";
import { DatabaseModule } from "../database/database.module";
import { ReferralController } from "./referral.controller";
import { ReferralProcessor } from "./referral.processor";
import { ReferralService } from "./referral.service";
import { ReferralApiService } from "./referral-api.service";
import { ReferralProcessingService } from "./referral-processing.service";
import { ReferralThrottlerGuard } from "./referral-throttler.guard";

@Module({
  imports: [
    AuthModule,
    DatabaseModule,
    ThrottlerModule.forRoot([
      {
        name: "referral-validation",
        ttl: 3600,
        limit: 10,
      },
      {
        name: "manual-triggers",
        ttl: 3600,
        limit: 1,
      },
    ]),
    BullModule.registerQueue({
      name: REFERRAL_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 2000,
        },
        removeOnComplete: 100, // Keep last 100 successful jobs
        removeOnFail: 50, // Keep last 50 failed jobs
      },
    }),
    BullBoardModule.forFeature({
      name: REFERRAL_QUEUE,
      adapter: BullMQAdapter,
    }),
  ],
  controllers: [ReferralController],
  providers: [
    ReferralService,
    ReferralApiService,
    ReferralProcessingService,
    ReferralProcessor,
    ReferralThrottlerGuard,
  ],
  exports: [ReferralService, ReferralApiService, ReferralProcessingService, BullModule],
})
export class ReferralModule {}
