import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ThrottlerModule } from "@nestjs/throttler";
import { GooglePlacesService } from "./google-places.service";
import { MapsController } from "./maps.controller";
import { MapsService } from "./maps.service";
import { PlacesController } from "./places.controller";
import { PlacesThrottlerGuard } from "./places-throttler.guard";
import { PLACES_THROTTLE_CONFIG } from "./places-throttling.config";

@Module({
  imports: [
    ConfigModule,
    ThrottlerModule.forRoot([
      {
        name: PLACES_THROTTLE_CONFIG.name,
        ttl: PLACES_THROTTLE_CONFIG.ttlMs,
        limit: PLACES_THROTTLE_CONFIG.limits.autocomplete,
      },
    ]),
  ],
  controllers: [MapsController, PlacesController],
  providers: [MapsService, GooglePlacesService, PlacesThrottlerGuard],
  exports: [MapsService, GooglePlacesService],
})
export class MapsModule {}
