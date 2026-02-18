import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { MapsController } from "./maps.controller";
import { MapsService } from "./maps.service";

@Module({
  imports: [ConfigModule],
  controllers: [MapsController],
  providers: [MapsService],
  exports: [MapsService],
})
export class MapsModule {}
