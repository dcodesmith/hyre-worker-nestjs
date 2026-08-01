import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { BookingStatus, PaymentStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  BookingOutsideModificationWindowException,
  BookingStatusNotModifiableException,
} from "./booking.error";
import { BookingModificationPolicyService } from "./booking-modification-policy.service";

describe("BookingModificationPolicyService", () => {
  const startDate = new Date("2026-08-02T12:00:00.000Z");

  async function createService(cutoffHours = 12) {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingModificationPolicyService,
        {
          provide: ConfigService,
          useValue: { get: vi.fn().mockReturnValue(cutoffHours) },
        },
      ],
    }).compile();

    return module.get(BookingModificationPolicyService);
  }

  it("allows a paid confirmed booking before the cutoff", async () => {
    const service = await createService();
    const eligibility = service.getEligibility(
      {
        status: BookingStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
        startDate,
      },
      true,
      new Date("2026-08-01T23:59:59.999Z"),
    );

    expect(eligibility).toEqual({
      canEdit: true,
      canCancel: true,
      modificationCutoffAt: "2026-08-02T00:00:00.000Z",
      policyHoursBeforeStart: 12,
    });
  });

  it("closes edit and cancel eligibility at the exact cutoff", async () => {
    const service = await createService();
    const eligibility = service.getEligibility(
      {
        status: BookingStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
        startDate,
      },
      true,
      new Date("2026-08-02T00:00:00.000Z"),
    );

    expect(eligibility.canEdit).toBe(false);
    expect(eligibility.canCancel).toBe(false);
  });

  it("allows editing but not cancellation for an unpaid confirmed booking", async () => {
    const service = await createService();
    const eligibility = service.getEligibility(
      {
        status: BookingStatus.CONFIRMED,
        paymentStatus: PaymentStatus.UNPAID,
        startDate,
      },
      true,
      new Date("2026-08-01T00:00:00.000Z"),
    );

    expect(eligibility.canEdit).toBe(true);
    expect(eligibility.canCancel).toBe(false);
  });

  it("denies edit and cancellation for non-confirmed bookings", async () => {
    const service = await createService();
    const eligibility = service.getEligibility(
      {
        status: BookingStatus.ACTIVE,
        paymentStatus: PaymentStatus.PAID,
        startDate,
      },
      true,
      new Date("2026-08-01T00:00:00.000Z"),
    );

    expect(eligibility.canEdit).toBe(false);
    expect(eligibility.canCancel).toBe(false);
  });

  it("denies actor eligibility without changing policy metadata", async () => {
    const service = await createService();
    const eligibility = service.getEligibility(
      {
        status: BookingStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
        startDate,
      },
      false,
      new Date("2026-08-01T00:00:00.000Z"),
    );

    expect(eligibility).toEqual({
      canEdit: false,
      canCancel: false,
      modificationCutoffAt: "2026-08-02T00:00:00.000Z",
      policyHoursBeforeStart: 12,
    });
  });

  it("throws stable errors for closed windows and invalid states", async () => {
    const service = await createService();
    const confirmedBooking = {
      status: BookingStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID,
      startDate,
    };

    expect(() =>
      service.assertCanEdit(confirmedBooking, new Date("2026-08-02T00:00:00.000Z")),
    ).toThrow(BookingOutsideModificationWindowException);
    expect(() =>
      service.assertCanCancel(
        { ...confirmedBooking, status: BookingStatus.COMPLETED },
        new Date("2026-08-01T00:00:00.000Z"),
      ),
    ).toThrow(BookingStatusNotModifiableException);
  });

  it("uses the configured cutoff", async () => {
    const service = await createService(24);
    const eligibility = service.getEligibility(
      {
        status: BookingStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
        startDate,
      },
      true,
      new Date("2026-08-01T11:59:59.999Z"),
    );

    expect(eligibility.modificationCutoffAt).toBe("2026-08-01T12:00:00.000Z");
    expect(eligibility.policyHoursBeforeStart).toBe(24);
  });
});
