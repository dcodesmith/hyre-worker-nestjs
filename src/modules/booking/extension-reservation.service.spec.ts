import { Test, type TestingModule } from "@nestjs/testing";
import { PaymentAttemptStatus, PaymentStatus } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { DatabaseService } from "../database/database.service";
import { BookingReservationService } from "./booking-reservation.service";
import { ExtensionReservationService } from "./extension-reservation.service";

describe("ExtensionReservationService", () => {
  let service: ExtensionReservationService;
  const tx = {
    $queryRaw: vi.fn(),
    extension: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    extensionCreationIdempotency: {
      deleteMany: vi.fn(),
    },
    payment: {
      count: vi.fn(),
    },
    bookingLeg: {
      findMany: vi.fn(),
    },
    booking: {
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  const databaseService = {
    extension: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn((callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  const bookingReservationService = {
    isOverlapConstraintViolation: vi.fn().mockReturnValue(false),
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    databaseService.extension.findUnique.mockResolvedValue({
      bookingLegId: "leg-1",
      bookingLeg: {
        booking: {
          id: "booking-1",
          carId: "car-1",
        },
      },
    });
    tx.$queryRaw.mockResolvedValue([{ id: "locked" }]);
    tx.extension.findUnique.mockResolvedValue({
      createdAt: new Date("2026-08-29T20:00:00.000Z"),
      paymentSessionExpiresAt: new Date("2026-08-29T20:10:00.000Z"),
      paymentStatus: PaymentStatus.UNPAID,
      status: "PENDING",
    });
    tx.payment.count.mockResolvedValue(0);
    tx.extension.updateMany.mockResolvedValue({ count: 1 });
    tx.extensionCreationIdempotency.deleteMany.mockResolvedValue({ count: 1 });
    tx.bookingLeg.findMany.mockResolvedValue([
      {
        legEndTime: new Date("2026-08-29T19:00:00.000Z"),
        extensions: [
          {
            extensionEndTime: new Date("2026-08-29T21:00:00.000Z"),
          },
        ],
      },
      {
        legEndTime: new Date("2026-08-30T18:00:00.000Z"),
        extensions: [],
      },
    ]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExtensionReservationService,
        { provide: DatabaseService, useValue: databaseService },
        { provide: BookingReservationService, useValue: bookingReservationService },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get(ExtensionReservationService);
  });

  it("claims and reserves a legacy extension payment session before provider use", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T20:00:00.000Z"));
    const extensionEndTime = new Date("2026-08-29T22:00:00.000Z");
    tx.extension.findUnique.mockResolvedValueOnce({
      extensionEndTime,
      paymentIntent: null,
      paymentStatus: PaymentStatus.UNPAID,
      status: "PENDING",
      bookingLeg: {
        booking: {
          id: "booking-1",
          status: "CONFIRMED",
          userId: "user-1",
        },
      },
    });

    await expect(
      service.claimPaymentSession("extension-1", "user-1", "extension_extension-1"),
    ).resolves.toBe(true);

    expect(tx.extension.updateMany).toHaveBeenCalledWith({
      where: {
        id: "extension-1",
        status: "PENDING",
        paymentStatus: PaymentStatus.UNPAID,
        paymentIntent: null,
      },
      data: {
        paymentIntent: "extension_extension-1",
        paymentSessionExpiresAt: new Date("2026-08-29T20:10:00.000Z"),
      },
    });
    expect(tx.booking.updateMany).toHaveBeenCalledWith({
      where: {
        id: "booking-1",
        endDate: { lt: extensionEndTime },
      },
      data: { endDate: extensionEndTime },
    });
  });

  it("cancels an expired unpaid extension and releases its booking window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T20:11:00.000Z"));

    await expect(service.cancelExpiredReservation("extension-1")).resolves.toBe(true);

    expect(tx.payment.count).toHaveBeenCalledWith({
      where: {
        extensionId: "extension-1",
        status: PaymentAttemptStatus.SUCCESSFUL,
      },
    });
    expect(tx.extension.updateMany).toHaveBeenCalledWith({
      where: {
        id: "extension-1",
        status: "PENDING",
        paymentStatus: PaymentStatus.UNPAID,
      },
      data: { status: "CANCELLED" },
    });
    expect(tx.extensionCreationIdempotency.deleteMany).toHaveBeenCalledWith({
      where: { extensionId: "extension-1" },
    });
    expect(tx.booking.update).toHaveBeenCalledWith({
      where: { id: "booking-1" },
      data: { endDate: new Date("2026-08-30T18:00:00.000Z") },
    });
  });

  it("retains an expired extension when a successful payment already exists", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T20:11:00.000Z"));
    tx.payment.count.mockResolvedValueOnce(1);

    await expect(service.cancelExpiredReservation("extension-1")).resolves.toBe(false);

    expect(tx.extension.updateMany).not.toHaveBeenCalled();
    expect(tx.booking.update).not.toHaveBeenCalled();
  });

  it("retains an extension whose payment session has not expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T20:09:00.000Z"));

    await expect(service.cancelExpiredReservation("extension-1")).resolves.toBe(false);

    expect(tx.payment.count).not.toHaveBeenCalled();
    expect(tx.extension.updateMany).not.toHaveBeenCalled();
  });
});
