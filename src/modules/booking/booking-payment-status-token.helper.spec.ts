import { describe, expect, it } from "vitest";
import {
  createBookingPaymentStatusToken,
  matchesBookingPaymentStatusToken,
} from "./booking-payment-status-token.helper";

describe("booking payment status token", () => {
  it("creates an opaque token and validates only its matching hash", () => {
    const credential = createBookingPaymentStatusToken(
      "booking-123",
      "test-secret-with-at-least-32-characters",
    );

    expect(credential.token).toHaveLength(43);
    expect(credential.tokenHash).not.toContain(credential.token);
    expect(matchesBookingPaymentStatusToken(credential.token, credential.tokenHash)).toBe(true);
    expect(matchesBookingPaymentStatusToken("wrong-token", credential.tokenHash)).toBe(false);
  });

  it("derives a stable token for idempotent replays", () => {
    const secret = "test-secret-with-at-least-32-characters";

    expect(createBookingPaymentStatusToken("booking-123", secret)).toEqual(
      createBookingPaymentStatusToken("booking-123", secret),
    );
    expect(createBookingPaymentStatusToken("booking-456", secret).token).not.toBe(
      createBookingPaymentStatusToken("booking-123", secret).token,
    );
  });
});
