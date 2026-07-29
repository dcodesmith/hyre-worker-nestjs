import { Module } from "@nestjs/common";
import { ThrottlerModule } from "@nestjs/throttler";
import { AuthModule } from "../auth/auth.module";
import { DatabaseModule } from "../database/database.module";
import { NotificationModule } from "../notification/notification.module";
import { ReferralController } from "./referral.controller";
import { ReferralService } from "./referral.service";
import { ReferralApiService } from "./referral-api.service";
import { ReferralProcessingService } from "./referral-processing.service";
import { ReferralThrottlerGuard } from "./referral-throttler.guard";
import { REFERRAL_THROTTLE_CONFIG } from "./referral-throttling.config";

@Module({
  imports: [
    AuthModule,
    DatabaseModule,
    NotificationModule,
    ThrottlerModule.forRoot([
      {
        name: REFERRAL_THROTTLE_CONFIG.name,
        ttl: REFERRAL_THROTTLE_CONFIG.ttlMs,
        limit: REFERRAL_THROTTLE_CONFIG.userLimit,
      },
      {
        name: "manual-triggers",
        ttl: 3600 * 1000,
        limit: 1,
      },
    ]),
  ],
  controllers: [ReferralController],
  providers: [
    ReferralService,
    ReferralApiService,
    ReferralProcessingService,
    ReferralThrottlerGuard,
  ],
  exports: [ReferralService, ReferralApiService, ReferralProcessingService],
})
export class ReferralModule {}
