import { ConfigModule, ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { describe, expect, it, vi } from "vitest";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";
import { MonoService } from "../mono/mono.service";
import { BankAccountLookupModule } from "./bank-account-lookup.module";
import { BANK_ACCOUNT_LOOKUP, type BankAccountLookup } from "./bank-account-lookup.service";

const BANK_NAME = "GTBank Plc";
const BANK_CODE = "058";
const ACCOUNT_NUMBER = "0123456789";
const flutterwaveBanks = [{ code: BANK_CODE, name: BANK_NAME }];

describe.each([
  ["production", "flutterwave"],
  ["development", "mono"],
  ["preview", "mono"],
] as const)("BankAccountLookupModule in %s", (appEnv, accountProvider) => {
  it("keeps Flutterwave bank codes and resolves with the environment provider", async () => {
    const flutterwaveService = {
      listNigerianBanks: vi.fn().mockResolvedValue(flutterwaveBanks),
      resolveBankAccount: vi.fn().mockResolvedValue({
        accountNumber: ACCOUNT_NUMBER,
        accountName: "JOHN DOE",
        bankCode: BANK_CODE,
      }),
    };
    const monoService = {
      listNigerianBanks: vi.fn().mockResolvedValue([{ code: "000013", name: "GTBANK PLC" }]),
      resolveBankAccount: vi.fn().mockResolvedValue({
        accountNumber: ACCOUNT_NUMBER,
        accountName: "JOHN DOE",
        bankCode: "000013",
      }),
    };
    const module = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), BankAccountLookupModule],
    })
      .overrideProvider(ConfigService)
      .useValue({ get: () => appEnv })
      .overrideProvider(FlutterwaveService)
      .useValue(flutterwaveService)
      .overrideProvider(MonoService)
      .useValue(monoService)
      .compile();

    const lookup = module.get<BankAccountLookup>(BANK_ACCOUNT_LOOKUP);
    await expect(lookup.listNigerianBanks()).resolves.toEqual(flutterwaveBanks);
    await lookup.resolveBankAccount(BANK_NAME, BANK_CODE, ACCOUNT_NUMBER);

    expect(flutterwaveService.listNigerianBanks).toHaveBeenCalledOnce();
    expect(monoService.listNigerianBanks).not.toHaveBeenCalled();
    if (accountProvider === "flutterwave") {
      expect(flutterwaveService.resolveBankAccount).toHaveBeenCalledWith(BANK_CODE, ACCOUNT_NUMBER);
      expect(monoService.resolveBankAccount).not.toHaveBeenCalled();
      return;
    }

    expect(monoService.resolveBankAccount).toHaveBeenCalledWith(
      BANK_NAME,
      BANK_CODE,
      ACCOUNT_NUMBER,
    );
    expect(flutterwaveService.resolveBankAccount).not.toHaveBeenCalled();
  });
});
