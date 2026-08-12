import { describe, expect, it } from "vitest";
import { BookingValidationException } from "./booking.error";
import { validateCreditsRequireAuthentication } from "./booking-credits.auth";

describe("validateCreditsRequireAuthentication", () => {
  it("rejects referral credits for guest bookings", () => {
    expect(() => validateCreditsRequireAuthentication(5000, null)).toThrow(
      BookingValidationException,
    );
  });

  it("allows credits for authenticated bookings", () => {
    expect(() => validateCreditsRequireAuthentication(5000, { id: "user-123" })).not.toThrow();
  });
});
