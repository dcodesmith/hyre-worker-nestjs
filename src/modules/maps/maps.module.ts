import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ThrottlerModule } from "@nestjs/throttler";
import { GooglePlacesService } from "./google-places.service";
import { MapsController } from "./maps.controller";
import { MapsService } from "./maps.service";
import { TripDurationThrottlerGuard } from "./maps-throttler.guard";
import { PlacesController } from "./places.controller";
import { PlacesThrottlerGuard } from "./places-throttler.guard";

@Module({
  imports: [ConfigModule, ThrottlerModule],
  controllers: [MapsController, PlacesController],
  providers: [MapsService, GooglePlacesService, PlacesThrottlerGuard, TripDurationThrottlerGuard],
  exports: [MapsService, GooglePlacesService],
})
export class MapsModule {}
