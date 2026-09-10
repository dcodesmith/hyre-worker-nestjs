import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AxiosInstance } from "axios";
import type { z } from "zod";
import type { EnvConfig } from "../../config/env.config";
import { HttpClientService } from "../http-client/http-client.service";
import { VIN_PATTERN } from "./prembly.const";
import {
  PremblyCacResult,
  PremblyDriversLicenseResult,
  PremblyFaceComparisonResult,
  PremblyInsuranceResult,
  PremblyLivenessResult,
  PremblyNinResult,
  PremblyPlateResult,
  PremblyVinResult,
} from "./prembly.interface";
import {
  premblyCacResponseSchema,
  premblyDriversLicenseResponseSchema,
  premblyEnvelopeSchema,
  premblyFaceComparisonResponseSchema,
  premblyInsuranceResponseSchema,
  premblyLivenessResponseSchema,
  premblyNinResponseSchema,
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
    const chassisNumber = response.data.vehicle_chasis?.trim().toUpperCase() ?? null;
    if (chassisNumber && !VIN_PATTERN.test(chassisNumber)) {
      throw new PremblyError("INVALID_RESPONSE");
    }

    return {
      policyNumber: response.data.policy_number,
      policyStatus: response.data.policy_status,
      plateNumbers: [response.data.new_reg_number, response.data.reg_number].filter(
        (plate): plate is string => Boolean(plate),
      ),
      chassisNumber,
      color: response.data.vehicle_color,
      expiresAt: response.data.expiry_date,
      reference: response.verification.reference,
    };
  }

  async verifyNin(nin: string): Promise<PremblyNinResult> {
    const response = await this.post(
      "/verification/vnin-basic",
      { number: nin },
      premblyNinResponseSchema,
    );
    if (response.data.nin !== nin || response.data.nin_suspension_status) {
      throw new PremblyError("REJECTED");
    }

    return {
      firstName: response.data.firstname.trim(),
      middleName: response.data.middlename?.trim() || null,
      lastName: response.data.surname.trim(),
      reference: response.verification.reference,
    };
  }

  async verifyDriversLicense(
    licenseNumber: string,
    firstName: string,
    lastName: string,
  ): Promise<PremblyDriversLicenseResult> {
    const response = await this.post(
      "/verification/drivers_license/advance/v2",
      {
        number: licenseNumber,
        first_name: firstName,
        last_name: lastName,
      },
      premblyDriversLicenseResponseSchema,
    );
    const license = response.frsc_data;
    if (this.normalizeName(license.driversLicense) !== this.normalizeName(licenseNumber)) {
      throw new PremblyError("REJECTED");
    }

    return {
      licenseNumber: license.driversLicense.trim().toUpperCase(),
      firstName: license.firstname.trim(),
      middleName: license.middlename?.trim() || null,
      lastName: license.lastname.trim(),
      dateOfBirth: this.parseFrscDate(license.birthdate),
      expiresAt: this.parseFrscDate(license.expiry_date),
      officialPhoto: license.photo,
      reference: response.verification.reference,
    };
  }

  async verifyFaceLiveness(image: string): Promise<PremblyLivenessResult> {
    const response = await this.post(
      "/verification/biometrics/face/liveliness_check",
      { image },
      premblyLivenessResponseSchema,
    );
    return {
      confidence: response.confidence,
      reference: response.verification.reference,
    };
  }

  async compareFaces(officialPhoto: string, selfie: string): Promise<PremblyFaceComparisonResult> {
    const response = await this.post(
      "/verification/biometrics/face/comparison",
      { image_one: officialPhoto, image_two: selfie },
      premblyFaceComparisonResponseSchema,
    );
    return { confidence: response.confidence };
  }

  async verifyCac(
    registrationNumber: string,
    registrationType: string,
    businessName: string,
  ): Promise<PremblyCacResult> {
    const response = await this.post(
      "/verification/cac/advance",
      {
        rc_number: registrationNumber,
        company_type: registrationType,
        company_name: businessName,
      },
      premblyCacResponseSchema,
    );
    const normalizedNumber = this.normalizeCacRegistrationNumber(registrationNumber);
    const normalizedType = registrationType.trim().toUpperCase();
    const candidates = response.data.filter(
      (company) =>
        this.normalizeCacRegistrationNumber(company.rc_number) === normalizedNumber &&
        company.entity_type.trim().toUpperCase() === normalizedType,
    );
    const company =
      candidates.find(
        (candidate) =>
          this.normalizeName(candidate.company_name) === this.normalizeName(businessName),
      ) ?? candidates[0];

    if (!company) {
      throw new PremblyError("INVALID_RESPONSE");
    }

    return {
      businessName: company.company_name.trim(),
      registrationNumber: company.rc_number.trim().toUpperCase(),
      registrationType: company.entity_type.trim().toUpperCase(),
      status: company.company_status?.trim().toUpperCase() || null,
      directors: company.directors
        .map((director) => ({
          firstName: director.firstname.trim(),
          middleName: director.otherName?.trim() || null,
          lastName: director.surname.trim(),
        }))
        .filter((director) => director.firstName || director.lastName),
      reference: response.verification.reference,
    };
  }

  private normalizeCacRegistrationNumber(value: string): string {
    return value.replaceAll(/\D/g, "").replace(/^0+/, "");
  }

  private normalizeName(value: string): string {
    return value.toUpperCase().replaceAll(/[^A-Z0-9]/g, "");
  }

  private parseFrscDate(value: string): Date {
    const [day, month, year] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      throw new PremblyError("INVALID_RESPONSE");
    }
    return date;
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
