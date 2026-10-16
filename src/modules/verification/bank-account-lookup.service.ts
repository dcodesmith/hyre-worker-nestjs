import { Injectable } from "@nestjs/common";
import type { EnvConfig } from "../../config/env.config";
import { FlutterwaveError } from "../flutterwave/flutterwave.interface";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";
import { MonoError, MonoService } from "../mono/mono.service";

export const BANK_ACCOUNT_LOOKUP = Symbol("BANK_ACCOUNT_LOOKUP");

export type NigerianBank = {
  code: string;
  name: string;
};

export type ResolvedBankAccount = {
  accountNumber: string;
  accountName: string;
  bankCode: string;
};

export interface BankAccountLookup {
  listNigerianBanks(): Promise<NigerianBank[]>;
  resolveBankAccount(
    bankName: string,
    bankCode: string,
    accountNumber: string,
  ): Promise<ResolvedBankAccount>;
}

export type BankAccountLookupErrorKind = "REJECTED" | "UNAVAILABLE";

export class BankAccountLookupError extends Error {
  constructor(readonly kind: BankAccountLookupErrorKind) {
    super(kind);
  }
}

function normalizeBankName(value: string): string {
  return value.toUpperCase().replaceAll(/[^A-Z0-9]/g, "");
}

@Injectable()
export class FlutterwaveBankAccountLookup implements BankAccountLookup {
  constructor(private readonly flutterwaveService: FlutterwaveService) {}

  listNigerianBanks() {
    return this.flutterwaveService.listNigerianBanks();
  }

  async resolveBankAccount(
    _bankName: string,
    bankCode: string,
    accountNumber: string,
  ): Promise<ResolvedBankAccount> {
    try {
      return await this.flutterwaveService.resolveBankAccount(bankCode, accountNumber);
    } catch (error) {
      if (error instanceof FlutterwaveError) {
        throw new BankAccountLookupError(
          error.statusCode !== undefined && [400, 404, 422].includes(error.statusCode)
            ? "REJECTED"
            : "UNAVAILABLE",
        );
      }
      throw new BankAccountLookupError("UNAVAILABLE");
    }
  }
}

@Injectable()
export class MonoBankAccountLookup implements BankAccountLookup {
  constructor(private readonly monoService: MonoService) {}

  listNigerianBanks() {
    return this.monoService.listNigerianBanks();
  }

  async resolveBankAccount(
    bankName: string,
    bankCode: string,
    accountNumber: string,
  ): Promise<ResolvedBankAccount> {
    try {
      return await this.monoService.resolveBankAccount(bankName, bankCode, accountNumber);
    } catch (error) {
      if (error instanceof MonoError) {
        throw new BankAccountLookupError(error.kind === "REJECTED" ? "REJECTED" : "UNAVAILABLE");
      }
      throw new BankAccountLookupError("UNAVAILABLE");
    }
  }
}

export function selectBankAccountLookup(
  appEnv: EnvConfig["APP_ENV"],
  flutterwaveLookup: FlutterwaveBankAccountLookup,
  monoLookup: MonoBankAccountLookup,
): BankAccountLookup {
  if (appEnv === "production") return flutterwaveLookup;

  // Payouts submit the stored bank code to Flutterwave, so the public list keeps those codes.
  return {
    listNigerianBanks: () => flutterwaveLookup.listNigerianBanks(),
    resolveBankAccount: async (bankName, bankCode, accountNumber) => {
      try {
        const banks = await flutterwaveLookup.listNigerianBanks();
        const bank = banks.find(({ code }) => code === bankCode);
        if (!bank || normalizeBankName(bank.name) !== normalizeBankName(bankName)) {
          throw new BankAccountLookupError("REJECTED");
        }

        const resolved = await monoLookup.resolveBankAccount(bank.name, bank.code, accountNumber);
        return { ...resolved, bankCode: bank.code };
      } catch (error) {
        if (error instanceof BankAccountLookupError) throw error;
        throw new BankAccountLookupError("UNAVAILABLE");
      }
    },
  };
}
