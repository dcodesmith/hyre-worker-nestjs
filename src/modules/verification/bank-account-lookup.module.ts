import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { EnvConfig } from "../../config/env.config";
import { FlutterwaveModule } from "../flutterwave/flutterwave.module";
import { MonoModule } from "../mono/mono.module";
import {
  BANK_ACCOUNT_LOOKUP,
  FlutterwaveBankAccountLookup,
  MonoBankAccountLookup,
  selectBankAccountLookup,
} from "./bank-account-lookup.service";

@Module({
  imports: [FlutterwaveModule, MonoModule],
  providers: [
    FlutterwaveBankAccountLookup,
    MonoBankAccountLookup,
    {
      provide: BANK_ACCOUNT_LOOKUP,
      inject: [ConfigService, FlutterwaveBankAccountLookup, MonoBankAccountLookup],
      useFactory: (
        configService: ConfigService<EnvConfig, true>,
        flutterwaveLookup: FlutterwaveBankAccountLookup,
        monoLookup: MonoBankAccountLookup,
      ) =>
        selectBankAccountLookup(
          configService.get("APP_ENV", { infer: true }),
          flutterwaveLookup,
          monoLookup,
        ),
    },
  ],
  exports: [BANK_ACCOUNT_LOOKUP],
})
export class BankAccountLookupModule {}
