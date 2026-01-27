import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { HttpClientService } from "../../shared/http-client.service";
import { MapsService } from "./maps.service";

@Module({
  imports: [ConfigModule],
  providers: [MapsService, HttpClientService],
  exports: [MapsService],
})
export class MapsModule {}
