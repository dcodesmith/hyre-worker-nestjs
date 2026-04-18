import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { FleetOwnerPromotionController } from "./fleet-owner-promotion.controller";
import { PromotionService } from "./promotion.service";

@Module({
  imports: [AuthModule],
  controllers: [FleetOwnerPromotionController],
  providers: [PromotionService],
  exports: [PromotionService],
})
export class PromotionModule {}
