import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { StorageModule } from "../storage/storage.module";
import { CarController } from "./car.controller";
import { CarService } from "./car.service";

@Module({
  imports: [AuthModule, StorageModule],
  controllers: [CarController],
  providers: [CarService],
  exports: [CarService],
})
export class CarModule {}
