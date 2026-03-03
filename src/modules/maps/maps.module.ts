import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { GooglePlacesService } from "./google-places.service";
import { MapsController } from "./maps.controller";
import { MapsService } from "./maps.service";

@Module({
  imports: [ConfigModule],
  controllers: [MapsController],
  providers: [MapsService, GooglePlacesService],
  exports: [MapsService, GooglePlacesService],
})
export class MapsModule {}
