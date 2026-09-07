import { describe, expect, it } from "vitest";
import {
  checkPhoneVerificationSchema,
  createAccountVerificationSchema,
  sendPhoneVerificationSchema,
} from "./account-verification.dto";

const validIndividual = {
  accountType: "INDIVIDUAL",
  nin: "12345678901",
  isOwnerDriver: false,
  bankName: "GTBank",
  bankCode: "058",
  accountNumber: "0123456789",
} as const;

const validBusiness = {
  ...validIndividual,
  accountType: "BUSINESS",
  businessName: "Hyre Mobility Limited",
  registrationNumber: "RC-123456",
  registrationType: "RC",
} as const;

describe("createAccountVerificationSchema", () => {
  it("accepts an individual payload", () => {
    const parsed = createAccountVerificationSchema.safeParse(validIndividual);

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual(validIndividual);
    }
  });

  it("accepts a business payload", () => {
    const parsed = createAccountVerificationSchema.safeParse(validBusiness);

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual(validBusiness);
    }
  });

  it.each([
    [true, true],
    [false, false],
    ["true", true],
    ["false", false],
  ] as const)("coerces multipart boolean %j to %s", (input, expected) => {
    const parsed = createAccountVerificationSchema.safeParse({
      ...validIndividual,
      isOwnerDriver: input,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.isOwnerDriver).toBe(expected);
    }
  });

  it("trims identity and bank fields", () => {
    const parsed = createAccountVerificationSchema.safeParse({
      ...validIndividual,
      nin: "  12345678901  ",
      bankName: "  GTBank  ",
      bankCode: "  058  ",
      accountNumber: "  0123456789  ",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toMatchObject({
        nin: "12345678901",
        bankName: "GTBank",
        bankCode: "058",
        accountNumber: "0123456789",
      });
    }
  });

  it.each(["1234567890", "123456789012", "1234567890a", ""])("rejects an invalid NIN %j", (nin) => {
    expect(createAccountVerificationSchema.safeParse({ ...validIndividual, nin }).success).toBe(
      false,
    );
  });

  it.each(["0", "1234567", "05A"])("rejects an invalid bank code %j", (bankCode) => {
    expect(
      createAccountVerificationSchema.safeParse({ ...validIndividual, bankCode }).success,
    ).toBe(false);
  });

  it.each(["012345678", "01234567890", "012345678a"])(
    "rejects an invalid account number %j",
    (accountNumber) => {
      expect(
        createAccountVerificationSchema.safeParse({ ...validIndividual, accountNumber }).success,
      ).toBe(false);
    },
  );

  it("rejects a business payload missing CAC fields", () => {
    expect(
      createAccountVerificationSchema.safeParse({
        ...validIndividual,
        accountType: "BUSINESS",
      }).success,
    ).toBe(false);
  });

  it.each(["XX", "rc", ""])("rejects an invalid registration type %j", (registrationType) => {
    expect(
      createAccountVerificationSchema.safeParse({ ...validBusiness, registrationType }).success,
    ).toBe(false);
  });

  it.each(["RC", "BN", "IT", "LP", "LLP"])("accepts registration type %s", (registrationType) => {
    expect(
      createAccountVerificationSchema.safeParse({ ...validBusiness, registrationType }).success,
    ).toBe(true);
  });

  it("rejects an unknown account type", () => {
    expect(
      createAccountVerificationSchema.safeParse({
        ...validIndividual,
        accountType: "JOINT",
      }).success,
    ).toBe(false);
  });

  it("rejects a one-character bank name after trim", () => {
    expect(
      createAccountVerificationSchema.safeParse({ ...validIndividual, bankName: " G " }).success,
    ).toBe(false);
  });
});

describe("sendPhoneVerificationSchema", () => {
  it("accepts an E.164 phone number", () => {
    const parsed = sendPhoneVerificationSchema.safeParse({ phoneNumber: "+2348012345678" });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.phoneNumber).toBe("+2348012345678");
    }
  });

  it("trims the phone number", () => {
    const parsed = sendPhoneVerificationSchema.safeParse({ phoneNumber: "  +2348012345678  " });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.phoneNumber).toBe("+2348012345678");
    }
  });

  it.each(["2348012345678", "+01234567", "+123", "08012345678", ""])(
    "rejects a non-E.164 phone number %j",
    (phoneNumber) => {
      expect(sendPhoneVerificationSchema.safeParse({ phoneNumber }).success).toBe(false);
    },
  );
});

describe("checkPhoneVerificationSchema", () => {
  it("accepts a 4 to 10 digit code", () => {
    const parsed = checkPhoneVerificationSchema.safeParse({
      phoneNumber: "+2348012345678",
      code: "123456",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.code).toBe("123456");
    }
  });

  it.each(["12", "12345678901", "12ab", ""])("rejects an invalid code %j", (code) => {
    expect(
      checkPhoneVerificationSchema.safeParse({
        phoneNumber: "+2348012345678",
        code,
      }).success,
    ).toBe(false);
  });
});
