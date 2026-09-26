import { Module } from "@nestjs/common";
import { SmileIdService } from "./smile-id.service";

@Module({
  providers: [SmileIdService],
  exports: [SmileIdService],
})
export class SmileIdModule {}
