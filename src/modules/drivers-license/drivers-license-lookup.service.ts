import { Injectable } from "@nestjs/common";
import type { MonoDriversLicenseResult } from "../mono/mono.interface";
import { MonoError, MonoService } from "../mono/mono.service";
import { PremblyError, PremblyService } from "../prembly/prembly.service";

@Injectable()
export class DriversLicenseLookupService {
  constructor(
    private readonly monoService: MonoService,
    private readonly premblyService: PremblyService,
  ) {}

  async lookup(
    licenseNumber: string,
    firstName: string,
    lastName: string,
    dateOfBirth: Date,
  ): Promise<MonoDriversLicenseResult> {
    try {
      return await this.monoService.verifyDriversLicense(
        licenseNumber,
        firstName,
        lastName,
        dateOfBirth,
      );
    } catch (error) {
      if (
        !(error instanceof MonoError) ||
        !["UNAVAILABLE", "INVALID_RESPONSE"].includes(error.kind)
      ) {
        throw error;
      }
      try {
        return await this.premblyService.verifyDriversLicense(licenseNumber, firstName, lastName);
      } catch (fallbackError) {
        if (
          fallbackError instanceof PremblyError &&
          fallbackError.kind === "REJECTED" &&
          fallbackError.reason === "UNCHARGED_RECORD_NOT_FOUND"
        ) {
          throw new PremblyError("INVALID_RESPONSE", fallbackError.reason);
        }
        throw fallbackError;
      }
    }
  }
}
