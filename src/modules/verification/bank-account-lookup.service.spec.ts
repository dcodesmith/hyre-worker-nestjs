import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FlutterwaveError } from "../flutterwave/flutterwave.interface";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";
import { MonoError, MonoService } from "../mono/mono.service";
import {
  BankAccountLookupError,
  FlutterwaveBankAccountLookup,
  MonoBankAccountLookup,
  selectBankAccountLookup,
} from "./bank-account-lookup.service";

const BANK_NAME = "GTBank Plc";
const BANK_CODE = "058";
const ACCOUNT_NUMBER = "0123456789";
const resolvedAccount = {
  accountNumber: ACCOUNT_NUMBER,
  accountName: "JOHN DOE",
  bankCode: BANK_CODE,
};

describe("FlutterwaveBankAccountLookup", () => {
  let service: FlutterwaveBankAccountLookup;
  let flutterwaveService: {
    listNigerianBanks: ReturnType<typeof vi.fn>;
    resolveBankAccount: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    flutterwaveService = {
      listNigerianBanks: vi.fn().mockResolvedValue([{ code: BANK_CODE, name: BANK_NAME }]),
      resolveBankAccount: vi.fn().mockResolvedValue(resolvedAccount),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FlutterwaveBankAccountLookup,
        { provide: FlutterwaveService, useValue: flutterwaveService },
      ],
    }).compile();

    service = module.get(FlutterwaveBankAccountLookup);
  });

  it("delegates bank listing", async () => {
    await expect(service.listNigerianBanks()).resolves.toEqual([
      { code: BANK_CODE, name: BANK_NAME },
    ]);
  });

  it("resolves without forwarding the provider-neutral bank name", async () => {
    await expect(service.resolveBankAccount(BANK_NAME, BANK_CODE, ACCOUNT_NUMBER)).resolves.toEqual(
      resolvedAccount,
    );
    expect(flutterwaveService.resolveBankAccount).toHaveBeenCalledWith(BANK_CODE, ACCOUNT_NUMBER);
  });

  it.each([400, 404, 422])("maps Flutterwave %s to a rejected lookup", async (statusCode) => {
    flutterwaveService.resolveBankAccount.mockRejectedValueOnce(
      new FlutterwaveError("Account not found", "ACCOUNT_NOT_FOUND", statusCode),
    );

    await expect(service.resolveBankAccount(BANK_NAME, BANK_CODE, ACCOUNT_NUMBER)).rejects.toEqual(
      new BankAccountLookupError("REJECTED"),
    );
  });

  it("maps Flutterwave outages to unavailable", async () => {
    flutterwaveService.resolveBankAccount.mockRejectedValueOnce(
      new FlutterwaveError("Provider unavailable", "PROVIDER_UNAVAILABLE", 502),
    );

    await expect(service.resolveBankAccount(BANK_NAME, BANK_CODE, ACCOUNT_NUMBER)).rejects.toEqual(
      new BankAccountLookupError("UNAVAILABLE"),
    );
  });
});

describe("MonoBankAccountLookup", () => {
  let service: MonoBankAccountLookup;
  let monoService: {
    listNigerianBanks: ReturnType<typeof vi.fn>;
    resolveBankAccount: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    monoService = {
      listNigerianBanks: vi.fn().mockResolvedValue([{ code: "000013", name: "GTBANK PLC" }]),
      resolveBankAccount: vi.fn().mockResolvedValue({ ...resolvedAccount, bankCode: "000013" }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [MonoBankAccountLookup, { provide: MonoService, useValue: monoService }],
    }).compile();

    service = module.get(MonoBankAccountLookup);
  });

  it("delegates bank listing", async () => {
    await expect(service.listNigerianBanks()).resolves.toEqual([
      { code: "000013", name: "GTBANK PLC" },
    ]);
  });

  it("forwards the complete lookup request to Mono", async () => {
    await service.resolveBankAccount(BANK_NAME, BANK_CODE, ACCOUNT_NUMBER);

    expect(monoService.resolveBankAccount).toHaveBeenCalledWith(
      BANK_NAME,
      BANK_CODE,
      ACCOUNT_NUMBER,
    );
  });

  it("maps Mono rejections to a rejected lookup", async () => {
    monoService.resolveBankAccount.mockRejectedValueOnce(new MonoError("REJECTED"));

    await expect(service.resolveBankAccount(BANK_NAME, BANK_CODE, ACCOUNT_NUMBER)).rejects.toEqual(
      new BankAccountLookupError("REJECTED"),
    );
  });

  it.each(["UNAVAILABLE", "INVALID_RESPONSE"] as const)(
    "maps Mono %s errors to unavailable",
    async (kind) => {
      monoService.resolveBankAccount.mockRejectedValueOnce(new MonoError(kind));

      await expect(
        service.resolveBankAccount(BANK_NAME, BANK_CODE, ACCOUNT_NUMBER),
      ).rejects.toEqual(new BankAccountLookupError("UNAVAILABLE"));
    },
  );
});

describe("selectBankAccountLookup", () => {
  const flutterwaveBanks = [{ code: BANK_CODE, name: BANK_NAME }];

  it("uses Flutterwave for production listing and resolution", () => {
    const flutterwaveLookup = { marker: "flutterwave" } as unknown as FlutterwaveBankAccountLookup;
    const monoLookup = { marker: "mono" } as unknown as MonoBankAccountLookup;

    expect(selectBankAccountLookup("production", flutterwaveLookup, monoLookup)).toBe(
      flutterwaveLookup,
    );
  });

  it.each(["development", "preview"] as const)(
    "lists Flutterwave bank codes and resolves through Mono in %s",
    async (appEnv) => {
      const flutterwaveLookup = {
        listNigerianBanks: vi.fn().mockResolvedValue(flutterwaveBanks),
        resolveBankAccount: vi.fn(),
      } as unknown as FlutterwaveBankAccountLookup;
      const monoLookup = {
        listNigerianBanks: vi.fn().mockResolvedValue([{ code: "000013", name: "GTBANK PLC" }]),
        resolveBankAccount: vi.fn().mockResolvedValue({ ...resolvedAccount, bankCode: "000013" }),
      } as unknown as MonoBankAccountLookup;

      const lookup = selectBankAccountLookup(appEnv, flutterwaveLookup, monoLookup);

      await expect(lookup.listNigerianBanks()).resolves.toEqual(flutterwaveBanks);
      await lookup.resolveBankAccount(BANK_NAME, BANK_CODE, ACCOUNT_NUMBER);

      expect(monoLookup.resolveBankAccount).toHaveBeenCalledWith(
        BANK_NAME,
        BANK_CODE,
        ACCOUNT_NUMBER,
      );
      expect(flutterwaveLookup.resolveBankAccount).not.toHaveBeenCalled();
      expect(monoLookup.listNigerianBanks).not.toHaveBeenCalled();
    },
  );
});
