import { describe, expect, it } from "vitest";
import { BookingValidationException } from "../booking.error";
import { IdempotencyKeyPipe } from "./idempotency-key.decorator";

describe("IdempotencyKeyPipe", () => {
  const pipe = new IdempotencyKeyPipe();

  it("returns a valid idempotency key", () => {
    expect(pipe.transform("booking-request:123")).toBe("booking-request:123");
  });

  it.each([
    ["a missing key", undefined],
    ["a short key", "short"],
    ["an oversized key", "a".repeat(129)],
    ["unsafe characters", "booking request"],
  ])("rejects %s", (_description, value) => {
    try {
      pipe.transform(value);
      expect.fail("Expected the idempotency key to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(BookingValidationException);
      expect((error as BookingValidationException).getProblemDetails().errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: "Idempotency-Key" })]),
      );
    }
  });
});
