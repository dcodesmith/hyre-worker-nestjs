import { Module } from "@nestjs/common";
import { NhtsaService } from "./nhtsa.service";

@Module({
  providers: [NhtsaService],
  exports: [NhtsaService],
})
export class NhtsaModule {}
