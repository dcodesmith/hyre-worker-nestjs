import { describe, expect, it, vi } from "vitest";
import type { MonoDriversLicenseResult } from "../modules/mono/mono.interface";
import { MonoError } from "../modules/mono/mono.service";
import { PremblyError } from "../modules/prembly/prembly.service";
import { lookupDriversLicense } from "./lookup-drivers-license";

const dateOfBirth = new Date(Date.UTC(1990, 0, 1));
const license: MonoDriversLicenseResult = {
  licenseNumber: "ABC12345DE67",
  firstName: "ADA",
  middleName: null,
  lastName: "LOVELACE",
  dateOfBirth,
  expiresAt: new Date(Date.UTC(2029, 0, 1)),
  officialPhoto: null,
  reference: "lic-ref",
};

describe("lookupDriversLicense", () => {
  const monoService = { verifyDriversLicense: vi.fn() };
  const premblyService = { verifyDriversLicense: vi.fn() };

  it("returns the Mono result without calling Prembly", async () => {
    monoService.verifyDriversLicense.mockResolvedValueOnce(license);

    await expect(
      lookupDriversLicense(
        monoService,
        premblyService,
        "ABC12345DE67",
        "ADA",
        "LOVELACE",
        dateOfBirth,
      ),
    ).resolves.toBe(license);
    expect(premblyService.verifyDriversLicense).not.toHaveBeenCalled();
  });

  it("does not call Prembly when Mono rejects the licence", async () => {
    monoService.verifyDriversLicense.mockRejectedValueOnce(new MonoError("REJECTED"));

    await expect(
      lookupDriversLicense(
        monoService,
        premblyService,
        "ABC12345DE67",
        "ADA",
        "LOVELACE",
        dateOfBirth,
      ),
    ).rejects.toEqual(new MonoError("REJECTED"));
    expect(premblyService.verifyDriversLicense).not.toHaveBeenCalled();
  });

  it.each(["UNAVAILABLE", "INVALID_RESPONSE"] as const)(
    "uses Prembly when Mono is %s",
    async (kind) => {
      monoService.verifyDriversLicense.mockRejectedValueOnce(new MonoError(kind));
      premblyService.verifyDriversLicense.mockResolvedValueOnce(license);

      await expect(
        lookupDriversLicense(
          monoService,
          premblyService,
          "ABC12345DE67",
          "ADA",
          "LOVELACE",
          dateOfBirth,
        ),
      ).resolves.toBe(license);
      expect(premblyService.verifyDriversLicense).toHaveBeenCalledWith(
        "ABC12345DE67",
        "ADA",
        "LOVELACE",
      );
    },
  );

  it("returns the Prembly rejection when the fallback fails", async () => {
    monoService.verifyDriversLicense.mockRejectedValueOnce(new MonoError("UNAVAILABLE"));
    premblyService.verifyDriversLicense.mockRejectedValueOnce(new PremblyError("REJECTED"));

    await expect(
      lookupDriversLicense(
        monoService,
        premblyService,
        "ABC12345DE67",
        "ADA",
        "LOVELACE",
        dateOfBirth,
      ),
    ).rejects.toEqual(new PremblyError("REJECTED"));
  });
});
