import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AxiosInstance } from "axios";
import type { z } from "zod";
import type { EnvConfig } from "../../config/env.config";
import { HttpClientService } from "../http-client/http-client.service";
import { VIN_PATTERN } from "./prembly.const";
import { PremblyInsuranceResult, PremblyPlateResult, PremblyVinResult } from "./prembly.interface";
import {
  premblyEnvelopeSchema,
  premblyInsuranceResponseSchema,
  premblyPlateResponseSchema,
  premblyVinResponseSchema,
} from "./prembly.schema";

export type PremblyErrorKind = "REJECTED" | "INVALID_RESPONSE" | "UNAVAILABLE";

export class PremblyError extends Error {
  constructor(readonly kind: PremblyErrorKind) {
    super(kind);
  }
}

@Injectable()
export class PremblyService {
  private readonly client: AxiosInstance;

  constructor(configService: ConfigService<EnvConfig, true>, httpClientService: HttpClientService) {
    const appId = configService.get("PREMBLY_APP_ID", { infer: true });
    this.client = httpClientService.createClient({
      serviceName: "Prembly",
      baseURL: configService.get("PREMBLY_BASE_URL", { infer: true }),
      timeout: 15_000,
      headers: {
        "x-api-key": configService.get("PREMBLY_API_KEY", { infer: true }),
        ...(appId && { "app-id": appId }),
      },
    });
  }

  async verifyPlate(plateNumber: string): Promise<PremblyPlateResult> {
    const response = await this.post(
      "/verification/vehicle",
      { vehicle_number: plateNumber },
      premblyPlateResponseSchema,
    );
    const vehicle = response.data.vehicle;
    const chassisNumber = (
      vehicle?.ChassisNo ??
      response.data.ChassisNo ??
      response.data.chassis_number ??
      ""
    )
      .trim()
      .toUpperCase();

    if (!VIN_PATTERN.test(chassisNumber)) {
      throw new PremblyError("INVALID_RESPONSE");
    }

    return {
      plateNumber: (response.data.vehicle_number ?? plateNumber).trim().toUpperCase(),
      chassisNumber,
      make: vehicle?.carMake?.trim() ?? response.data.vehicle_name?.trim() ?? null,
      model: vehicle?.carModel?.trim() ?? null,
      color: vehicle?.bodyColor?.trim() ?? response.data.vehicle_color?.trim() ?? null,
      reference: response.verification.reference,
    };
  }

  async verifyVin(chassisNumber: string): Promise<PremblyVinResult> {
    const response = await this.post(
      "/verification/vehicle/vin",
      { vin: chassisNumber },
      premblyVinResponseSchema,
    );
    const specification = Object.assign({}, ...response.data.vehicle_specification);
    const year = Number(specification.year);
    const passengerCapacity = Number(specification.standard_seating);
    const make = specification.make?.trim();
    const model = specification.model?.trim();

    if (
      !Number.isInteger(year) ||
      year < 1886 ||
      year > new Date().getFullYear() + 1 ||
      !make ||
      !model ||
      !Number.isInteger(passengerCapacity) ||
      passengerCapacity < 1 ||
      passengerCapacity > 15
    ) {
      throw new PremblyError("INVALID_RESPONSE");
    }

    return {
      year,
      make,
      model,
      passengerCapacity,
      reference: response.verification.reference,
    };
  }

  async verifyInsurance(policyNumber: string): Promise<PremblyInsuranceResult> {
    const response = await this.post(
      "/verification/insurance_policy",
      { channel: "policy", number: policyNumber },
      premblyInsuranceResponseSchema,
    );

    return {
      policyNumber: response.data.policy_number,
      policyStatus: response.data.policy_status,
      plateNumbers: [response.data.new_reg_number, response.data.reg_number].filter(
        (plate): plate is string => Boolean(plate),
      ),
      chassisNumber: response.data.vehicle_chasis?.trim().toUpperCase() ?? null,
      expiresAt: response.data.expiry_date,
      reference: response.verification.reference,
    };
  }

  private async post<T>(
    path: string,
    body: Record<string, string>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    try {
      const { data } = await this.client.post<unknown>(path, body);
      const envelope = premblyEnvelopeSchema.safeParse(data);

      if (!envelope.success) {
        throw new PremblyError("INVALID_RESPONSE");
      }

      if (["02", "03"].includes(envelope.data.response_code ?? "")) {
        throw new PremblyError("UNAVAILABLE");
      }

      if (!envelope.data.status || envelope.data.response_code === "01") {
        throw new PremblyError("REJECTED");
      }

      if (envelope.data.response_code !== "00") {
        throw new PremblyError("INVALID_RESPONSE");
      }

      const parsed = schema.safeParse(data);

      if (!parsed.success) {
        throw new PremblyError("INVALID_RESPONSE");
      }

      return parsed.data;
    } catch (error) {
      if (error instanceof PremblyError) throw error;
      throw new PremblyError("UNAVAILABLE");
    }
  }
}
