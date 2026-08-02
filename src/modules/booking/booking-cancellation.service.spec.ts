import { Test, type TestingModule } from "@nestjs/testing";
import { BookingStatus, PaymentStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { DatabaseService } from "../database/database.service";
import { BookingCancellationHandler } from "../notification/handlers/booking-cancellation.handler";
import { NotificationOutboxService } from "../notification/notification-outbox.service";
import {
  BookingCancellationFailedException,
  BookingNotFoundException,
  BookingOutsideModificationWindowException,
  BookingStatusNotModifiableException,
} from "./booking.error";
import { BookingCancellationService } from "./booking-cancellation.service";
import { BookingEligibilityService } from "./booking-eligibility.service";
import { BookingModificationPolicyService } from "./booking-modification-policy.service";

function getQueryText(query: unknown): string {
  if (Array.isArray(query)) {
    return query.join("");
  }
  return String(
    query && typeof query === "object" && "strings" in query
      ? (query as { strings: string[] }).strings.join("")
      : query,
  );
}

describe("BookingCancellationService", () => {
  let service: BookingCancellationService;

  const txMock = {
    booking: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    car: {
      update: vi.fn(),
    },
    $queryRaw: vi.fn(),
  };

  const databaseServiceMock = {
    $transaction: vi.fn(),
  };
  const notificationOutboxServiceMock = {
    create: vi.fn(),
  };
  const bookingCancellationHandlerMock = {
    eventType: "BOOKING_LIFECYCLE" as const,
    buildEvents: vi.fn(),
  };
  const bookingEligibilityServiceMock = {
    reversePendingReferralRewards: vi.fn(),
  };
  const bookingModificationPolicyServiceMock = {
    assertCancellableStatus: vi.fn(),
    assertCanCancel: vi.fn(),
    assertWithinWindow: vi.fn(),
    getModificationCutoffAt: vi.fn(
      (startDate: Date) => new Date(startDate.getTime() - 12 * 60 * 60 * 1000),
    ),
    getEligibility: vi.fn().mockReturnValue({
      canEdit: false,
      canCancel: false,
      modificationCutoffAt: "2026-08-02T00:00:00.000Z",
      policyHoursBeforeStart: 12,
    }),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    bookingModificationPolicyServiceMock.assertCancellableStatus.mockImplementation(
      (booking: { status: BookingStatus; paymentStatus: PaymentStatus }) => {
        if (
          booking.status !== BookingStatus.CONFIRMED ||
          booking.paymentStatus !== PaymentStatus.PAID
        ) {
          throw new BookingStatusNotModifiableException(
            "cancel",
            "Only paid confirmed bookings can be cancelled",
          );
        }
      },
    );
    bookingModificationPolicyServiceMock.assertCanCancel.mockImplementation(
      (
        booking: { status: BookingStatus; paymentStatus: PaymentStatus; startDate: Date },
        now = new Date(),
      ) => {
        if (
          booking.status !== BookingStatus.CONFIRMED ||
          booking.paymentStatus !== PaymentStatus.PAID
        ) {
          throw new BookingStatusNotModifiableException(
            "cancel",
            "Only paid confirmed bookings can be cancelled",
          );
        }
        if (now.getTime() >= booking.startDate.getTime() - 12 * 60 * 60 * 1000) {
          throw new BookingOutsideModificationWindowException(
            new Date(booking.startDate.getTime() - 12 * 60 * 60 * 1000),
            12,
          );
        }
      },
    );
    bookingModificationPolicyServiceMock.assertWithinWindow.mockImplementation(
      (startDate: Date, now = new Date()) => {
        if (now.getTime() >= startDate.getTime() - 12 * 60 * 60 * 1000) {
          throw new BookingOutsideModificationWindowException(
            new Date(startDate.getTime() - 12 * 60 * 60 * 1000),
            12,
          );
        }
      },
    );
    databaseServiceMock.$transaction.mockImplementation(
      async (callback: (transaction: typeof txMock) => unknown) => callback(txMock),
    );
    txMock.$queryRaw.mockImplementation((query: unknown) => {
      const queryText = getQueryText(query);
      if (queryText.includes('UPDATE "Booking"')) {
        return [{ id: "booking-1" }];
      }
      return queryText.includes('SELECT clock_timestamp() AS "policyNow"')
        ? [{ policyNow: new Date() }]
        : [{ id: "booking-1" }];
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingCancellationService,
        { provide: DatabaseService, useValue: databaseServiceMock },
        { provide: NotificationOutboxService, useValue: notificationOutboxServiceMock },
        { provide: BookingCancellationHandler, useValue: bookingCancellationHandlerMock },
        { provide: BookingEligibilityService, useValue: bookingEligibilityServiceMock },
        {
          provide: BookingModificationPolicyService,
          useValue: bookingModificationPolicyServiceMock,
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get<BookingCancellationService>(BookingCancellationService);
  });

  it("cancels a paid booking and marks payment as refund processing", async () => {
    const policyNow = new Date("2026-08-01T23:59:58.000Z");
    const responseNow = new Date("2026-08-01T23:59:59.000Z");
    txMock.booking.findUnique.mockResolvedValueOnce({
      id: "booking-1",
      userId: "user-1",
      status: BookingStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID,
      startDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      carId: "car-1",
    });
    txMock.booking.findUniqueOrThrow.mockResolvedValueOnce({
      id: "booking-1",
      status: BookingStatus.CANCELLED,
      car: { owner: {} },
      user: {},
      legs: [],
    });
    txMock.car.update.mockResolvedValueOnce({ id: "car-1", status: "AVAILABLE" });
    txMock.$queryRaw
      .mockResolvedValueOnce([{ id: "booking-1" }])
      .mockResolvedValueOnce([{ policyNow }])
      .mockResolvedValueOnce([{ id: "booking-1" }])
      .mockResolvedValueOnce([{ policyNow: responseNow }]);

    const result = await service.cancelBooking(
      "booking-1",
      "user-1",
      "User requested cancellation",
    );

    expect(result).toEqual(
      expect.objectContaining({ id: "booking-1", status: BookingStatus.CANCELLED }),
    );
    const updateQuery = txMock.$queryRaw.mock.calls[2]?.[0];
    expect(getQueryText(updateQuery)).toContain("clock_timestamp() <");
    expect(txMock.$queryRaw.mock.calls[2]?.slice(1)).toEqual(
      expect.arrayContaining([
        BookingStatus.CANCELLED,
        PaymentStatus.REFUND_PROCESSING,
        "User requested cancellation",
        "booking-1",
        "user-1",
      ]),
    );
    expect(txMock.car.update).toHaveBeenCalledWith({
      where: { id: "car-1" },
      data: { status: "AVAILABLE" },
    });
    expect(bookingEligibilityServiceMock.reversePendingReferralRewards).toHaveBeenCalledWith(
      txMock,
      "booking-1",
      "BOOKING_CANCELLED",
    );
    expect(notificationOutboxServiceMock.create).toHaveBeenCalledWith(
      bookingCancellationHandlerMock,
      { booking: expect.objectContaining({ id: "booking-1", status: BookingStatus.CANCELLED }) },
      txMock,
    );
    expect(bookingModificationPolicyServiceMock.assertCanCancel).toHaveBeenCalledOnce();
    expect(bookingModificationPolicyServiceMock.getEligibility).toHaveBeenCalledWith(
      expect.objectContaining({ id: "booking-1" }),
      true,
      responseNow,
    );
  });

  it("uses the database clock when the application clock is past the cutoff", async () => {
    const startDate = new Date("2026-08-03T12:00:00.000Z");
    const databaseNow = new Date("2026-08-02T23:59:59.999Z");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T00:00:00.001Z"));

    try {
      txMock.booking.findUnique.mockResolvedValueOnce({
        id: "booking-1",
        userId: "user-1",
        status: BookingStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
        startDate,
        carId: "car-1",
      });
      txMock.$queryRaw
        .mockResolvedValueOnce([{ id: "booking-1" }])
        .mockResolvedValueOnce([{ policyNow: databaseNow }])
        .mockResolvedValueOnce([{ id: "booking-1" }])
        .mockResolvedValueOnce([{ policyNow: databaseNow }]);
      txMock.booking.findUniqueOrThrow.mockResolvedValueOnce({
        id: "booking-1",
        status: BookingStatus.CANCELLED,
        car: { owner: {} },
        user: {},
        legs: [],
      });
      txMock.car.update.mockResolvedValueOnce({ id: "car-1", status: "AVAILABLE" });

      await expect(
        service.cancelBooking("booking-1", "user-1", "User requested cancellation"),
      ).resolves.toEqual(expect.objectContaining({ status: BookingStatus.CANCELLED }));
      expect(bookingModificationPolicyServiceMock.assertCanCancel).toHaveBeenCalledWith(
        expect.objectContaining({ id: "booking-1" }),
        databaseNow,
      );
      expect(bookingModificationPolicyServiceMock.getEligibility).toHaveBeenCalledWith(
        expect.objectContaining({ id: "booking-1" }),
        true,
        databaseNow,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws BookingNotFoundException when booking is missing or not owned by user", async () => {
    txMock.booking.findUnique.mockResolvedValueOnce(null);

    await expect(
      service.cancelBooking("missing-booking", "user-1", "User requested cancellation"),
    ).rejects.toBeInstanceOf(BookingNotFoundException);
  });

  it("throws BookingStatusNotModifiableException when booking status is not cancellable", async () => {
    txMock.booking.findUnique.mockResolvedValueOnce({
      id: "booking-1",
      userId: "user-1",
      status: BookingStatus.COMPLETED,
      paymentStatus: PaymentStatus.PAID,
      carId: "car-1",
    });

    await expect(
      service.cancelBooking("booking-1", "user-1", "User requested cancellation"),
    ).rejects.toBeInstanceOf(BookingStatusNotModifiableException);
  });

  it("rejects cancellation when booking state changes before persistence", async () => {
    txMock.booking.findUnique.mockResolvedValueOnce({
      id: "booking-1",
      userId: "user-1",
      status: BookingStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID,
      startDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      carId: "car-1",
    });
    txMock.$queryRaw.mockResolvedValueOnce([]);

    await expect(
      service.cancelBooking("booking-1", "user-1", "User requested cancellation"),
    ).rejects.toBeInstanceOf(BookingStatusNotModifiableException);
    expect(txMock.booking.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("rejects cancellation when the database cutoff expires inside the guarded write", async () => {
    const startDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const modificationCutoffAt = new Date(startDate.getTime() - 12 * 60 * 60 * 1000);
    txMock.booking.findUnique.mockResolvedValueOnce({
      id: "booking-1",
      userId: "user-1",
      status: BookingStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID,
      startDate,
      carId: "car-1",
    });
    txMock.$queryRaw
      .mockResolvedValueOnce([{ id: "booking-1" }])
      .mockResolvedValueOnce([{ policyNow: new Date(modificationCutoffAt.getTime() - 1) }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ policyNow: modificationCutoffAt }]);

    await expect(
      service.cancelBooking("booking-1", "user-1", "User requested cancellation"),
    ).rejects.toBeInstanceOf(BookingOutsideModificationWindowException);
    const updateQuery = txMock.$queryRaw.mock.calls[2]?.[0];
    expect(getQueryText(updateQuery)).toContain("clock_timestamp() <");
  });

  it("throws BookingCancellationFailedException when transaction fails unexpectedly", async () => {
    databaseServiceMock.$transaction.mockRejectedValueOnce(new Error("Transaction failed"));

    await expect(
      service.cancelBooking("booking-1", "user-1", "User requested cancellation"),
    ).rejects.toBeInstanceOf(BookingCancellationFailedException);
  });
});
