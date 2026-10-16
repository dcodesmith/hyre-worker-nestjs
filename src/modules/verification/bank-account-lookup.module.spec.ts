import { ConfigModule, ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";
import { MonoService } from "../mono/mono.service";
import { BankAccountLookupModule } from "./bank-account-lookup.module";
import {
  BANK_ACCOUNT_LOOKUP,
  type BankAccountLookup,
  FlutterwaveBankAccountLookup,
  MonoBankAccountLookup,
} from "./bank-account-lookup.service";

describe.each([
  ["production", FlutterwaveBankAccountLookup],
  ["development", MonoBankAccountLookup],
  ["preview", MonoBankAccountLookup],
] as const)("BankAccountLookupModule in %s", (appEnv, expectedProvider) => {
  it("binds the environment-specific adapter to the lookup token", async () => {
    const module = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), BankAccountLookupModule],
    })
      .overrideProvider(ConfigService)
      .useValue({ get: () => appEnv })
      .overrideProvider(FlutterwaveService)
      .useValue({})
      .overrideProvider(MonoService)
      .useValue({})
      .compile();

    expect(module.get<BankAccountLookup>(BANK_ACCOUNT_LOOKUP)).toBeInstanceOf(expectedProvider);
  });
});
