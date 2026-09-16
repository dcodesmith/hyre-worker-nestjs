import { Injectable } from "@nestjs/common";
import type { AxiosInstance } from "axios";
import { z } from "zod";
import { VIN_PATTERN } from "../../shared/vehicle-validation";
import { HttpClientService } from "../http-client/http-client.service";

const nhtsaResponseSchema = z.looseObject({
  Results: z.array(
    z.looseObject({
      VIN: z.string(),
      ErrorCode: z.string(),
      Make: z.string(),
      Model: z.string(),
      ModelYear: z.string(),
      Seats: z.string().optional().default(""),
    }),
  ),
});

export type NhtsaErrorKind = "REJECTED" | "INVALID_RESPONSE" | "UNAVAILABLE";

export class NhtsaError extends Error {
  constructor(readonly kind: NhtsaErrorKind) {
    super(kind);
  }
}

export type NhtsaVinResult = {
  year: number;
  make: string;
  model: string;
  passengerCapacity: number | null;
};

const CLEAN_VPIC_ERROR_CODE_SETS: ReadonlyArray<ReadonlySet<string>> = [
  new Set(["0"]),
  new Set(["0", "10"]),
  new Set(["1", "10"]),
  new Set(["1", "400"]),
  new Set(["1", "10", "400"]),
];

export function isCleanVpicErrorCode(errorCode: string): boolean {
  const codes = [
    ...new Set(
      errorCode
        .split(",")
        .map((code) => code.trim())
        .filter(Boolean),
    ),
  ];
  return CLEAN_VPIC_ERROR_CODE_SETS.some(
    (allowed) => codes.length === allowed.size && codes.every((code) => allowed.has(code)),
  );
}

@Injectable()
export class NhtsaService {
  private readonly client: AxiosInstance;

  constructor(httpClientService: HttpClientService) {
    this.client = httpClientService.createClient({
      serviceName: "NHTSA",
      baseURL: "https://vpic.nhtsa.dot.gov/api",
      timeout: 10_000,
      headers: { Accept: "application/json" },
    });
  }

  async verifyVin(chassisNumber: string): Promise<NhtsaVinResult> {
    const normalizedVin = chassisNumber.trim().toUpperCase();
    if (!VIN_PATTERN.test(normalizedVin)) {
      throw new NhtsaError("REJECTED");
    }

    try {
      const { data } = await this.client.get<unknown>(
        `/vehicles/DecodeVinValues/${normalizedVin}`,
        { params: { format: "json" } },
      );
      const parsed = nhtsaResponseSchema.safeParse(data);
      if (!parsed.success) {
        throw new NhtsaError("INVALID_RESPONSE");
      }

      const vehicle = parsed.data.Results[0];
      if (!vehicle) {
        throw new NhtsaError("REJECTED");
      }
      if (vehicle.VIN.trim().toUpperCase() !== normalizedVin) {
        throw new NhtsaError("INVALID_RESPONSE");
      }
      if (!isCleanVpicErrorCode(vehicle.ErrorCode)) {
        throw new NhtsaError("REJECTED");
      }

      const year = Number(vehicle.ModelYear);
      const make = vehicle.Make.trim();
      const model = vehicle.Model.trim();
      if (
        !Number.isInteger(year) ||
        year < 1886 ||
        year > new Date().getFullYear() + 1 ||
        !make ||
        !model
      ) {
        throw new NhtsaError("INVALID_RESPONSE");
      }

      const decodedSeats = Number(vehicle.Seats);
      const passengerCapacity =
        Number.isInteger(decodedSeats) && decodedSeats >= 1 && decodedSeats <= 15
          ? decodedSeats
          : null;

      return { year, make, model, passengerCapacity };
    } catch (error) {
      if (error instanceof NhtsaError) throw error;
      throw new NhtsaError("UNAVAILABLE");
    }
  }
}
