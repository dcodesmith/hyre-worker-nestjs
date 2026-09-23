import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AxiosInstance } from "axios";
import { z } from "zod";
import type { EnvConfig } from "../../config/env.config";
import { HttpClientService } from "../http-client/http-client.service";
import { RegCheckErrorKind, RegCheckPlateResult } from "./regcheck.interface";

const VEHICLE_JSON = /<vehicleJson>([\s\S]*?)<\/vehicleJson>/;

const regCheckVehicleSchema = z.looseObject({
  CarMake: z.looseObject({ CurrentTextValue: z.string() }),
  CarModel: z.looseObject({ CurrentTextValue: z.string() }),
  Colour: z.string().optional(),
});

export class RegCheckError extends Error {
  constructor(readonly kind: RegCheckErrorKind) {
    super(kind);
  }
}

@Injectable()
export class RegCheckService {
  private readonly client: AxiosInstance;
  private readonly username: string;

  constructor(configService: ConfigService<EnvConfig, true>, httpClientService: HttpClientService) {
    this.username = configService.get("REGCHECK_USERNAME", { infer: true });
    this.client = httpClientService.createClient({
      serviceName: "RegCheck",
      baseURL: "https://www.carregistrationapi.com.ng",
      timeout: 10_000,
      headers: { Accept: "text/xml" },
    });
  }

  async verifyPlate(plateNumber: string): Promise<RegCheckPlateResult> {
    const normalizedPlate = plateNumber.trim().toUpperCase();

    try {
      const { data } = await this.client.post<string>(
        "/api/reg.asmx/CheckNigeria",
        new URLSearchParams({
          RegistrationNumber: normalizedPlate,
          username: this.username,
        }),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
      );
      const vehicle = regCheckVehicleSchema.parse(readVehicleJson(String(data)));
      const make = vehicle.CarMake.CurrentTextValue.trim();
      const model = vehicle.CarModel.CurrentTextValue.trim();
      if (!make || !model) {
        throw new RegCheckError("INVALID_RESPONSE");
      }

      const color = vehicle.Colour?.trim() || null;
      return {
        plateNumber: normalizedPlate,
        vehicleName: `${make} ${model}`,
        color,
      };
    } catch (error) {
      if (error instanceof RegCheckError) throw error;
      if (error instanceof z.ZodError) throw new RegCheckError("INVALID_RESPONSE");
      throw new RegCheckError("UNAVAILABLE");
    }
  }
}

function readVehicleJson(xml: string): unknown {
  const match = VEHICLE_JSON.exec(xml);
  if (!match?.[1]) {
    throw new RegCheckError("INVALID_RESPONSE");
  }
  try {
    return JSON.parse(match[1]) as unknown;
  } catch {
    throw new RegCheckError("INVALID_RESPONSE");
  }
}
