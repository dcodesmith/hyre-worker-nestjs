import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { CarModule } from "../car/car.module";
import { PremblyModule } from "../prembly/prembly.module";
import {
  InsuranceVerificationController,
  VehicleVerificationController,
} from "./vehicle-verification.controller";
import { VehicleVerificationService } from "./vehicle-verification.service";
import { VerificationThrottlerGuard } from "./verification-throttler.guard";

@Module({
  imports: [AuthModule, CarModule, PremblyModule],
  controllers: [VehicleVerificationController, InsuranceVerificationController],
  providers: [VehicleVerificationService, VerificationThrottlerGuard],
})
export class VerificationModule {}
