import { describe, expect, it } from "vitest";
import { confirmBookingPaymentSchema } from "./confirm-booking-payment.dto";
import { reconcileBookingExpirationSchema } from "./reconcile-booking-expiration.dto";

const BOOKING_ID = "01994a1d-4263-7000-8000-000000000001";

describe("payment booking ID validation", () => {
  it("validates booking IDs when confirming payment", () => {
    const confirmation = {
      bookingId: BOOKING_ID,
      txRef: "tx-1",
      transactionId: "12345",
    };

    expect(confirmBookingPaymentSchema.safeParse(confirmation).success).toBe(true);
    expect(
      confirmBookingPaymentSchema.safeParse({
        ...confirmation,
        bookingId: "not-a-uuid",
      }).success,
    ).toBe(false);
  });

  it("validates booking IDs when reconciling expiration", () => {
    expect(
      reconcileBookingExpirationSchema.safeParse({
        bookingId: BOOKING_ID,
        txRef: "tx-1",
      }).success,
    ).toBe(true);
    expect(
      reconcileBookingExpirationSchema.safeParse({
        bookingId: "not-a-uuid",
        txRef: "tx-1",
      }).success,
    ).toBe(false);
  });
});
