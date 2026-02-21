import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { DatabaseModule } from "../database/database.module";
import { RatesController } from "./rates.controller";
import { RatesService } from "./rates.service";
import { RatesAdminService } from "./rates-admin.service";

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [RatesController],
  providers: [RatesService, RatesAdminService],
  exports: [RatesService],
})
export class RatesModule {}
