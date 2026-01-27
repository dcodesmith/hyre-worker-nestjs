import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { DatabaseModule } from "../database/database.module";
import { HttpClientService } from "../../shared/http-client.service";
import { FlightAwareService } from "./flightaware.service";

@Module({
  imports: [ConfigModule, DatabaseModule],
  providers: [FlightAwareService, HttpClientService],
  exports: [FlightAwareService],
})
export class FlightAwareModule {}
