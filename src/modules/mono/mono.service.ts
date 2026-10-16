import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios, { type AxiosInstance } from "axios";
import type { z } from "zod";
import type { EnvConfig } from "../../config/env.config";
import { HttpClientService } from "../http-client/http-client.service";
import type {
  MonoBank,
  MonoBankAccountResult,
  MonoDriversLicenseResult,
  MonoNinResult,
} from "./mono.interface";
import {
  monoBankAccountResponseSchema,
  monoBankListResponseSchema,
  monoDriversLicenseResponseSchema,
  monoEnvelopeSchema,
  monoNinResponseSchema,
} from "./mono.schema";

export type MonoErrorKind = "REJECTED" | "INVALID_RESPONSE" | "UNAVAILABLE";

export class MonoError extends Error {
  constructor(readonly kind: MonoErrorKind) {
    super(kind);
  }
}

const REJECTED_HTTP_STATUSES = new Set([400, 404, 422]);
const BANK_LIST_TTL_MS = 60 * 60 * 1000;

@Injectable()
export class MonoService {
  private readonly client: AxiosInstance;
  private bankListCache: { data: MonoBank[]; expiresAt: number } | null = null;

  constructor(configService: ConfigService<EnvConfig, true>, httpClientService: HttpClientService) {
    this.client = httpClientService.createClient({
      serviceName: "Mono",
      baseURL: configService.get("MONO_BASE_URL", { infer: true }),
      timeout: 15_000,
      headers: {
        accept: "application/json",
        "mono-sec-key": configService.get("MONO_SECRET_KEY", { infer: true }),
      },
    });
  }

  async verifyNin(nin: string): Promise<MonoNinResult> {
    const response = await this.post("/v3/lookup/nin", { nin }, monoNinResponseSchema);
    if (response.data.nin !== nin) {
      throw new MonoError("REJECTED");
    }

    return {
      firstName: response.data.firstname,
      middleName: response.data.middlename,
      lastName: response.data.surname,
      dateOfBirth: this.parseDate(response.data.birthdate),
      officialPhoto: response.data.photo,
      reference: this.reference(response.timestamp, "nin"),
    };
  }

  async verifyDriversLicense(
    licenseNumber: string,
    firstName: string,
    lastName: string,
    dateOfBirth: Date,
  ): Promise<MonoDriversLicenseResult> {
    const response = await this.post(
      "/v3/lookup/driver_license",
      {
        license_number: licenseNumber,
        first_name: firstName,
        last_name: lastName,
        date_of_birth: this.formatDate(dateOfBirth),
      },
      monoDriversLicenseResponseSchema,
    );
    const license = response.data;
    if (this.normalizeIdentifier(license.license_no) !== this.normalizeIdentifier(licenseNumber)) {
      throw new MonoError("REJECTED");
    }

    return {
      licenseNumber: license.license_no.trim().toUpperCase(),
      firstName: license.first_name,
      middleName: license.middle_name,
      lastName: license.last_name,
      dateOfBirth: this.parseDate(license.birth_date),
      expiresAt: this.parseDate(license.expiry_date),
      officialPhoto: license.photo,
      reference: this.reference(response.timestamp, "driver-license"),
    };
  }

  async resolveBankAccount(
    bankName: string,
    bankCode: string,
    accountNumber: string,
  ): Promise<MonoBankAccountResult> {
    const banks = await this.listNigerianBanks();
    const submittedName = this.normalizeIdentifier(bankName);
    const bank =
      banks.find(
        ({ code, name }) => code === bankCode && this.normalizeIdentifier(name) === submittedName,
      ) ?? banks.find(({ name }) => this.normalizeIdentifier(name) === submittedName);
    if (!bank) {
      throw new MonoError("REJECTED");
    }

    const response = await this.post(
      "/v3/lookup/account-number",
      {
        nip_code: bank.code,
        account_number: accountNumber,
      },
      monoBankAccountResponseSchema,
    );
    if (response.data.account_number !== accountNumber || response.data.bank.code !== bank.code) {
      throw new MonoError("REJECTED");
    }

    return {
      accountNumber: response.data.account_number,
      accountName: response.data.name.trim(),
      bankCode: response.data.bank.code,
    };
  }

  async listNigerianBanks(): Promise<MonoBank[]> {
    if (this.bankListCache && this.bankListCache.expiresAt > Date.now()) {
      return this.bankListCache.data;
    }

    const response = await this.get("/v3/lookup/banks", monoBankListResponseSchema);
    const banks = response.data.banks
      .map(({ name, nip_code }) => ({ code: nip_code, name }))
      .sort((left, right) => left.name.localeCompare(right.name));
    this.bankListCache = { data: banks, expiresAt: Date.now() + BANK_LIST_TTL_MS };
    return banks;
  }

  private formatDate(value: Date): string {
    if (Number.isNaN(value.getTime())) {
      throw new MonoError("INVALID_RESPONSE");
    }
    return value.toISOString().slice(0, 10);
  }

  private parseDate(value: string): Date {
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (iso) {
      return this.utcDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    }
    const dayFirst = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value);
    if (dayFirst) {
      return this.utcDate(Number(dayFirst[3]), Number(dayFirst[2]), Number(dayFirst[1]));
    }
    throw new MonoError("INVALID_RESPONSE");
  }

  private utcDate(year: number, month: number, day: number): Date {
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      throw new MonoError("INVALID_RESPONSE");
    }
    return date;
  }

  private normalizeIdentifier(value: string): string {
    return value.toUpperCase().replaceAll(/[^A-Z0-9]/g, "");
  }

  private reference(timestamp: string | undefined, lookup: "nin" | "driver-license"): string {
    return timestamp?.trim() || `mono:${lookup}`;
  }

  private async post<T>(
    path: string,
    body: Record<string, string>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    return this.request(() => this.client.post<unknown>(path, body), schema);
  }

  private async get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    return this.request(() => this.client.get<unknown>(path), schema);
  }

  private async request<T>(
    request: () => Promise<{ data: unknown }>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    try {
      const { data } = await request();
      const envelope = monoEnvelopeSchema.safeParse(data);

      if (!envelope.success) {
        throw new MonoError("INVALID_RESPONSE");
      }

      if (envelope.data.status.toLowerCase() !== "successful") {
        throw new MonoError("REJECTED");
      }

      const parsed = schema.safeParse(data);
      if (!parsed.success) {
        throw new MonoError("INVALID_RESPONSE");
      }

      return parsed.data;
    } catch (error) {
      if (error instanceof MonoError) throw error;
      if (axios.isAxiosError(error) && error.response) {
        if (REJECTED_HTTP_STATUSES.has(error.response.status)) {
          throw new MonoError("REJECTED");
        }
      }
      throw new MonoError("UNAVAILABLE");
    }
  }
}
