import type { MonoDriversLicenseResult } from "../modules/mono/mono.interface";
import { MonoError, type MonoService } from "../modules/mono/mono.service";
import type { PremblyService } from "../modules/prembly/prembly.service";

export async function lookupDriversLicense(
  monoService: Pick<MonoService, "verifyDriversLicense">,
  premblyService: Pick<PremblyService, "verifyDriversLicense">,
  licenseNumber: string,
  firstName: string,
  lastName: string,
  dateOfBirth: Date,
): Promise<MonoDriversLicenseResult> {
  try {
    return await monoService.verifyDriversLicense(licenseNumber, firstName, lastName, dateOfBirth);
  } catch (error) {
    if (
      !(error instanceof MonoError) ||
      !["UNAVAILABLE", "INVALID_RESPONSE"].includes(error.kind)
    ) {
      throw error;
    }
    return premblyService.verifyDriversLicense(licenseNumber, firstName, lastName);
  }
}
