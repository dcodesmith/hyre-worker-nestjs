import { Module } from "@nestjs/common";
import { ThrottlerModule } from "@nestjs/throttler";
import { AuthModule } from "../auth/auth.module";
import { DatabaseModule } from "../database/database.module";
import { NotificationModule } from "../notification/notification.module";
import { AdminReferralProgramController } from "./admin-referral-program.controller";
import { ReferralController } from "./referral.controller";
import { ReferralService } from "./referral.service";
import { ReferralApiService } from "./referral-api.service";
import { ReferralProcessingService } from "./referral-processing.service";
import { ReferralProgramModule } from "./referral-program.module";
import { ReferralThrottlerGuard } from "./referral-throttler.guard";

@Module({
  imports: [AuthModule, DatabaseModule, NotificationModule, ReferralProgramModule, ThrottlerModule],
  controllers: [ReferralController, AdminReferralProgramController],
  providers: [
    ReferralService,
    ReferralApiService,
    ReferralProcessingService,
    ReferralThrottlerGuard,
  ],
  exports: [ReferralService, ReferralApiService, ReferralProcessingService],
})
export class ReferralModule {}
