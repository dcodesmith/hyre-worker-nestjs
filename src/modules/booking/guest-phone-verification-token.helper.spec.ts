import { describe, expect, it } from "vitest";
import {
  createGuestPhoneVerificationToken,
  matchesGuestPhoneVerificationToken,
} from "./guest-phone-verification-token.helper";

const SECRET = "test-secret";
const PHONE = "+2348012345678";
const NOW = 1_700_000_000_000;

describe("guest phone verification tokens", () => {
  it("accepts an unexpired token bound to the same phone", () => {
    const token = createGuestPhoneVerificationToken(PHONE, SECRET, NOW);

    expect(matchesGuestPhoneVerificationToken(token, PHONE, SECRET, NOW + 1)).toBe(true);
    expect(matchesGuestPhoneVerificationToken(token, PHONE, SECRET, NOW + 30 * 60_000 - 1)).toBe(
      true,
    );
  });

  it("rejects a wrong phone, a forged signature, a malformed token, and an expired token", () => {
    const token = createGuestPhoneVerificationToken(PHONE, SECRET, NOW);
    const forged = createGuestPhoneVerificationToken(PHONE, "other-secret", NOW);
    const expired = createGuestPhoneVerificationToken(PHONE, SECRET, NOW - 31 * 60_000);

    expect(matchesGuestPhoneVerificationToken(undefined, PHONE, SECRET, NOW)).toBe(false);
    expect(matchesGuestPhoneVerificationToken(token, "+2348099999999", SECRET, NOW + 1)).toBe(
      false,
    );
    expect(matchesGuestPhoneVerificationToken(forged, PHONE, SECRET, NOW + 1)).toBe(false);
    expect(matchesGuestPhoneVerificationToken("not-a-token", PHONE, SECRET, NOW)).toBe(false);
    expect(matchesGuestPhoneVerificationToken(`${NOW + 60_000}.`, PHONE, SECRET, NOW)).toBe(false);
    expect(
      matchesGuestPhoneVerificationToken(`${NOW + 60_000}.signature.extra`, PHONE, SECRET, NOW),
    ).toBe(false);
    expect(matchesGuestPhoneVerificationToken(expired, PHONE, SECRET, NOW)).toBe(false);
    expect(matchesGuestPhoneVerificationToken(token, PHONE, SECRET, NOW + 30 * 60_000)).toBe(false);
  });
});
