import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { CarModule } from "../car/car.module";
import { PremblyModule } from "../prembly/prembly.module";
import { StorageModule } from "../storage/storage.module";
import {
  AccountVerificationController,
  AdminAccountVerificationController,
} from "./account-verification.controller";
import { AccountVerificationService } from "./account-verification.service";
import { PhoneVerificationService } from "./phone-verification.service";
import {
  InsuranceVerificationController,
  VehicleVerificationController,
} from "./vehicle-verification.controller";
import { VehicleVerificationService } from "./vehicle-verification.service";
import { VerificationThrottlerGuard } from "./verification-throttler.guard";

@Module({
  imports: [AuthModule, CarModule, PremblyModule, StorageModule],
  controllers: [
    VehicleVerificationController,
    InsuranceVerificationController,
    AccountVerificationController,
    AdminAccountVerificationController,
  ],
  providers: [
    VehicleVerificationService,
    AccountVerificationService,
    PhoneVerificationService,
    VerificationThrottlerGuard,
  ],
})
export class VerificationModule {}
