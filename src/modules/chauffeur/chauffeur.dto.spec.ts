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
  name: "Ada Lovelace",
  email: "ada@example.com",
  phoneNumber: "+2348012345678",
};

describe("createChauffeurInvitationSchema", () => {
  it("trims name and phone and lowercases the email", () => {
    const parsed = createChauffeurInvitationSchema.safeParse({
      name: "  Ada Lovelace  ",
      email: "  ADA@Example.COM  ",
      phoneNumber: "  +2348012345678  ",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.email).toBe("ada@example.com");
      expect(parsed.data).toEqual(validInvite);
    }
  });

  it("rejects a short name, invalid email, and non-E.164 phone", () => {
    expect(createChauffeurInvitationSchema.safeParse({ ...validInvite, name: "A" }).success).toBe(
      false,
    );
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
  it("accepts an alphanumeric licence number", () => {
    expect(
      verifyChauffeurDrivingSchema.safeParse({ driversLicenseNumber: "ABC-12345" }).success,
    ).toBe(true);
  });

  it("rejects a licence number with spaces or symbols", () => {
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
  it("accepts a cuid", () => {
    expect(chauffeurIdParamSchema.safeParse("ckx7b9q1e0000qwertyuiopas").success).toBe(true);
  });
});
