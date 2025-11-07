import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { REFERRAL_QUEUE } from "../../config/constants";
import { DatabaseModule } from "../database/database.module";
import { ReferralProcessor } from "./referral.processor";
import { ReferralService } from "./referral.service";

@Module({
  imports: [
    DatabaseModule,
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
  providers: [ReferralService, ReferralProcessor],
  exports: [ReferralService, BullModule],
})
export class ReferralModule {}
