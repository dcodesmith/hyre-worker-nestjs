import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { DatabaseModule } from "../database/database.module";
import { FlightAwareService } from "./flightaware.service";

@Module({
  imports: [ConfigModule, DatabaseModule],
  providers: [FlightAwareService],
  exports: [FlightAwareService],
})
export class FlightAwareModule {}
