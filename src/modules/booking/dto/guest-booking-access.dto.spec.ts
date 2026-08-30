import { describe, expect, it } from "vitest";
import {
  guestBookingAccessQuerySchema,
  guestBookingAccessRequestSchema,
} from "./guest-booking-access.dto";

describe("guest booking access DTOs", () => {
  it("normalizes the booking reference and email", () => {
    expect(
      guestBookingAccessRequestSchema.parse({
        bookingReference: " bk-123 ",
        email: " Guest@Example.com ",
      }),
    ).toEqual({ bookingReference: "BK-123", email: "guest@example.com" });
  });

  it("requires an opaque 32-byte base64url token", () => {
    expect(guestBookingAccessQuerySchema.safeParse({ token: "a".repeat(43) }).success).toBe(true);
    expect(guestBookingAccessQuerySchema.safeParse({ token: "too-short" }).success).toBe(false);
  });
});
