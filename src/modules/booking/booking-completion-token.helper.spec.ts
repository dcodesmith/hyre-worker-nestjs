import { describe, expect, it } from "vitest";
import {
  createBookingCompletionToken,
  hashBookingCompletionToken,
} from "./booking-completion-token.helper";

describe("booking completion token", () => {
  it("derives a stable token without storing the bearer credential", () => {
    const expiresAt = new Date("2026-08-18T12:00:00.000Z");
    const secret = "test-secret-at-least-32-characters-long";
    const first = createBookingCompletionToken("booking-1", expiresAt, secret);
    const second = createBookingCompletionToken("booking-1", expiresAt, secret);

    expect(first).toEqual(second);
    expect(first.tokenHash).toBe(hashBookingCompletionToken(first.token));
    expect(first.tokenHash).not.toContain(first.token);
  });

  it("derives different tokens for different bookings", () => {
    const expiresAt = new Date("2026-08-18T12:00:00.000Z");
    const secret = "test-secret-at-least-32-characters-long";

    expect(createBookingCompletionToken("booking-1", expiresAt, secret).token).not.toBe(
      createBookingCompletionToken("booking-2", expiresAt, secret).token,
    );
  });
});
