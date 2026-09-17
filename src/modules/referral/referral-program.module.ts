import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { ReferralProgramService } from "./referral-program.service";

@Module({
  imports: [DatabaseModule],
  providers: [ReferralProgramService],
  exports: [ReferralProgramService],
})
export class ReferralProgramModule {}
