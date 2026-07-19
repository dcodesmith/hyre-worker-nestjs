import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PromotionModule } from "../promotion/promotion.module";
import { ReviewsModule } from "../reviews/reviews.module";
import { StorageModule } from "../storage/storage.module";
import { AdminCarController } from "./admin-car.controller";
import { CarController } from "./car.controller";
import { CarService } from "./car.service";
import { CarApprovalService } from "./car-approval.service";
import { CarCategoriesService } from "./car-categories.service";
import { CarPromotionEnrichmentService } from "./car-promotion.enrichment";
import { CarRatingsEnrichmentService } from "./car-ratings.enrichment";
import { CarSearchService } from "./car-search.service";
import { FleetOwnerCarController } from "./fleet-owner-car.controller";

@Module({
  imports: [AuthModule, StorageModule, PromotionModule, ReviewsModule],
  controllers: [CarController, FleetOwnerCarController, AdminCarController],
  providers: [
    CarService,
    CarApprovalService,
    CarCategoriesService,
    CarSearchService,
    CarPromotionEnrichmentService,
    CarRatingsEnrichmentService,
  ],
  exports: [CarService, CarApprovalService, CarCategoriesService, CarSearchService],
})
export class CarModule {}
