import { Test, type TestingModule } from "@nestjs/testing";
import { BookingStatus, PaymentStatus, Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { DatabaseService } from "../database/database.service";
import { BookingEligibilityService } from "./booking-eligibility.service";
import { BookingReservationService } from "./booking-reservation.service";

describe("BookingReservationService", () => {
  let service: BookingReservationService;
  const tx = {
    $queryRaw: vi.fn(),
    booking: { updateMany: vi.fn() },
    payment: { count: vi.fn() },
  };
  const databaseService = {
    booking: { findUnique: vi.fn() },
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  const bookingEligibilityService = {
    releaseReferralReservation: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingReservationService,
        { provide: DatabaseService, useValue: databaseService },
        { provide: BookingEligibilityService, useValue: bookingEligibilityService },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get(BookingReservationService);
  });

  it("cancels an expired unpaid reservation after confirming no successful payment", async () => {
    databaseService.booking.findUnique.mockResolvedValue({ carId: "car-1" });
    tx.$queryRaw.mockResolvedValueOnce([{ id: "car-1" }]).mockResolvedValueOnce([
      {
        id: "booking-1",
        status: BookingStatus.PENDING,
        paymentStatus: PaymentStatus.UNPAID,
        paymentSessionExpiresAt: new Date(Date.now() - 60_000),
      },
    ]);
    tx.payment.count.mockResolvedValue(0);
    bookingEligibilityService.releaseReferralReservation.mockResolvedValue({ released: true });
    tx.booking.updateMany.mockResolvedValue({ count: 1 });

    await expect(service.cancelExpiredReservation("booking-1")).resolves.toBe(true);

    expect(bookingEligibilityService.releaseReferralReservation).toHaveBeenCalledWith(
      tx,
      "booking-1",
    );
    expect(tx.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: BookingStatus.CANCELLED,
          cancellationReason: "Payment session expired",
        }),
      }),
    );
  });

  it("retains an expired reservation when a successful payment exists", async () => {
    databaseService.booking.findUnique.mockResolvedValue({ carId: "car-1" });
    tx.$queryRaw.mockResolvedValueOnce([{ id: "car-1" }]).mockResolvedValueOnce([
      {
        id: "booking-1",
        status: BookingStatus.PENDING,
        paymentStatus: PaymentStatus.UNPAID,
        paymentSessionExpiresAt: new Date(Date.now() - 60_000),
      },
    ]);
    tx.payment.count.mockResolvedValue(1);

    await expect(service.cancelExpiredReservation("booking-1")).resolves.toBe(false);

    expect(tx.booking.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["the payment session is still active", () => new Date(Date.now() + 60_000)],
    ["the payment session expiry is missing", () => null],
  ])("retains a reservation when %s", async (_description, getExpiresAt) => {
    databaseService.booking.findUnique.mockResolvedValue({ carId: "car-1" });
    tx.$queryRaw.mockResolvedValueOnce([{ id: "car-1" }]).mockResolvedValueOnce([
      {
        id: "booking-1",
        status: BookingStatus.PENDING,
        paymentStatus: PaymentStatus.UNPAID,
        paymentSessionExpiresAt: getExpiresAt(),
      },
    ]);

    await expect(service.cancelExpiredReservation("booking-1")).resolves.toBe(false);

    expect(tx.payment.count).not.toHaveBeenCalled();
    expect(bookingEligibilityService.releaseReferralReservation).not.toHaveBeenCalled();
    expect(tx.booking.updateMany).not.toHaveBeenCalled();
  });

  it("recognizes the PostgreSQL booking overlap constraint", () => {
    const error = new Prisma.PrismaClientUnknownRequestError(
      'Database error code: 23P01 constraint "Booking_car_active_window_excl"',
      { clientVersion: "test" },
    );

    expect(service.isOverlapConstraintViolation(error)).toBe(true);
  });
});
