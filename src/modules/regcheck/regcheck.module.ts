import { Module } from "@nestjs/common";
import { RegCheckService } from "./regcheck.service";

@Module({
  providers: [RegCheckService],
  exports: [RegCheckService],
})
export class RegCheckModule {}
