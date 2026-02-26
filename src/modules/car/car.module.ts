import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { StorageModule } from "../storage/storage.module";
import { CarController } from "./car.controller";
import { CarService } from "./car.service";
import { CarCategoriesService } from "./car-categories.service";
import { CarSearchService } from "./car-search.service";
import { FleetOwnerCarController } from "./fleet-owner-car.controller";

@Module({
  imports: [AuthModule, StorageModule],
  controllers: [CarController, FleetOwnerCarController],
  providers: [CarService, CarCategoriesService, CarSearchService],
  exports: [CarService, CarCategoriesService, CarSearchService],
})
export class CarModule {}
