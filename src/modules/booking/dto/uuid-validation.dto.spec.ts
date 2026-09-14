import { describe, expect, it } from "vitest";
import { assignBookingChauffeurBodySchema } from "./assign-chauffeur.dto";
import { bookingPaymentStatusQuerySchema } from "./get-booking-payment-status.dto";
import { pricingPreviewBodySchema } from "./pricing-preview.dto";

const UUID = "01994a1d-4263-7000-8000-000000000001";

describe("booking UUID validation", () => {
  it("validates chauffeur IDs", () => {
    expect(assignBookingChauffeurBodySchema.safeParse({ chauffeurId: UUID }).success).toBe(true);
    expect(assignBookingChauffeurBodySchema.safeParse({ chauffeurId: "not-a-uuid" }).success).toBe(
      false,
    );
  });

  it("validates booking IDs in payment status queries", () => {
    expect(
      bookingPaymentStatusQuerySchema.safeParse({ bookingId: UUID, txRef: "tx-1" }).success,
    ).toBe(true);
    expect(
      bookingPaymentStatusQuerySchema.safeParse({
        bookingId: "not-a-uuid",
        txRef: "tx-1",
      }).success,
    ).toBe(false);
  });

  it("validates car IDs in pricing previews", () => {
    const preview = {
      carId: UUID,
      bookingType: "DAY",
      startDate: new Date("2030-01-01T09:00:00Z"),
      endDate: new Date("2030-01-01T21:00:00Z"),
      pickupTime: "9 AM",
    };

    expect(pricingPreviewBodySchema.safeParse(preview).success).toBe(true);
    expect(pricingPreviewBodySchema.safeParse({ ...preview, carId: "not-a-uuid" }).success).toBe(
      false,
    );
  });
});
