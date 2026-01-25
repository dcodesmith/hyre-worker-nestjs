import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { RatesService } from "./rates.service";

@Module({
  imports: [DatabaseModule],
  providers: [RatesService],
  exports: [RatesService],
})
export class RatesModule {}
