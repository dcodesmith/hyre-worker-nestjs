import { describe, expect, it } from "vitest";
import {
  acceptChauffeurConsentSchema,
  chauffeurIdParamSchema,
  checkChauffeurPhoneSchema,
  createChauffeurInvitationSchema,
  exchangeChauffeurInvitationSchema,
  listChauffeursQuerySchema,
  updateChauffeurSchema,
  verifyChauffeurDrivingSchema,
  verifyChauffeurNinSchema,
} from "./chauffeur.dto";

const validInvite = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  phoneNumber: "+2348012345678",
};

describe("createChauffeurInvitationSchema", () => {
  it("trims both names and phone and lowercases the email", () => {
    const parsed = createChauffeurInvitationSchema.safeParse({
      firstName: "  Ada  ",
      lastName: "  Lovelace  ",
      email: "  ADA@Example.COM  ",
      phoneNumber: "  +2348012345678  ",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.email).toBe("ada@example.com");
      expect(parsed.data).toEqual(validInvite);
    }
  });

  it("rejects an empty name, invalid email, and non-E.164 phone", () => {
    expect(
      createChauffeurInvitationSchema.safeParse({ ...validInvite, firstName: "" }).success,
    ).toBe(false);
    expect(
      createChauffeurInvitationSchema.safeParse({ ...validInvite, email: "not-an-email" }).success,
    ).toBe(false);
    expect(
      createChauffeurInvitationSchema.safeParse({ ...validInvite, phoneNumber: "08012345678" })
        .success,
    ).toBe(false);
  });
});

describe("exchangeChauffeurInvitationSchema", () => {
  it("accepts a long enough token", () => {
    expect(exchangeChauffeurInvitationSchema.safeParse({ token: "a".repeat(32) }).success).toBe(
      true,
    );
  });

  it("rejects a short token", () => {
    expect(exchangeChauffeurInvitationSchema.safeParse({ token: "short" }).success).toBe(false);
  });
});

describe("acceptChauffeurConsentSchema", () => {
  it("requires both consents to be true", () => {
    expect(
      acceptChauffeurConsentSchema.safeParse({ termsAccepted: true, privacyAccepted: true })
        .success,
    ).toBe(true);
    expect(
      acceptChauffeurConsentSchema.safeParse({ termsAccepted: false, privacyAccepted: true })
        .success,
    ).toBe(false);
  });
});

describe("checkChauffeurPhoneSchema", () => {
  it("accepts a 4 to 10 digit code", () => {
    expect(checkChauffeurPhoneSchema.safeParse({ code: "1234" }).success).toBe(true);
    expect(checkChauffeurPhoneSchema.safeParse({ code: "1234567890" }).success).toBe(true);
  });

  it("rejects a non-digit or out-of-range code", () => {
    expect(checkChauffeurPhoneSchema.safeParse({ code: "12" }).success).toBe(false);
    expect(checkChauffeurPhoneSchema.safeParse({ code: "12ab" }).success).toBe(false);
  });
});

describe("verifyChauffeurNinSchema", () => {
  it("accepts an 11-digit NIN", () => {
    expect(verifyChauffeurNinSchema.safeParse({ nin: "12345678901" }).success).toBe(true);
  });

  it("rejects a NIN that is not exactly 11 digits", () => {
    expect(verifyChauffeurNinSchema.safeParse({ nin: "1234567890" }).success).toBe(false);
  });
});

describe("verifyChauffeurDrivingSchema", () => {
  it("canonicalizes a hyphenated FRSC licence number", () => {
    const parsed = verifyChauffeurDrivingSchema.safeParse({
      driversLicenseNumber: "  abc-12345-de67  ",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.driversLicenseNumber).toBe("ABC12345DE67");
    }
  });

  it("rejects a licence number that is not the current FRSC shape", () => {
    expect(
      verifyChauffeurDrivingSchema.safeParse({ driversLicenseNumber: "ABC12345" }).success,
    ).toBe(false);
    expect(
      verifyChauffeurDrivingSchema.safeParse({ driversLicenseNumber: "ABC 123" }).success,
    ).toBe(false);
  });
});

describe("listChauffeursQuerySchema", () => {
  it("coerces pagination and applies defaults", () => {
    const parsed = listChauffeursQuerySchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({ page: 1, limit: 20 });
    }
  });

  it("rejects a limit above 100", () => {
    expect(listChauffeursQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });
});

describe("updateChauffeurSchema", () => {
  it("requires a boolean isActive flag", () => {
    expect(updateChauffeurSchema.safeParse({ isActive: false }).success).toBe(true);
    expect(updateChauffeurSchema.safeParse({ isActive: "yes" }).success).toBe(false);
  });
});

describe("chauffeurIdParamSchema", () => {
  it("accepts a UUID", () => {
    expect(chauffeurIdParamSchema.safeParse("01994a1d-4263-7000-8000-000000000001").success).toBe(
      true,
    );
  });
});
