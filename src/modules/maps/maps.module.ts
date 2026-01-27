import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { MapsService } from "./maps.service";

@Module({
  imports: [ConfigModule],
  providers: [MapsService],
  exports: [MapsService],
})
export class MapsModule {}
