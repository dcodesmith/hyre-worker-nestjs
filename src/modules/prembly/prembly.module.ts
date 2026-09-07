import { Module } from "@nestjs/common";
import { PremblyService } from "./prembly.service";

@Module({
  providers: [PremblyService],
  exports: [PremblyService],
})
export class PremblyModule {}
