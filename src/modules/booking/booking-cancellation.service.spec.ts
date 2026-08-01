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
  BookingStatusNotModifiableException,
} from "./booking.error";
import { BookingCancellationService } from "./booking-cancellation.service";
import { BookingEligibilityService } from "./booking-eligibility.service";
import { BookingModificationPolicyService } from "./booking-modification-policy.service";

describe("BookingCancellationService", () => {
  let service: BookingCancellationService;

  const txMock = {
    booking: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    car: {
      update: vi.fn(),
    },
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
    assertCanCancel: vi.fn(),
    getEligibility: vi.fn().mockReturnValue({
      canEdit: false,
      canCancel: false,
      modificationCutoffAt: "2026-08-02T00:00:00.000Z",
      policyHoursBeforeStart: 12,
    }),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    bookingModificationPolicyServiceMock.assertCanCancel.mockImplementation(
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
    databaseServiceMock.$transaction.mockImplementation(
      async (callback: (transaction: typeof txMock) => unknown) => callback(txMock),
    );
    txMock.booking.updateMany.mockResolvedValue({ count: 1 });

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

    const result = await service.cancelBooking(
      "booking-1",
      "user-1",
      "User requested cancellation",
    );

    expect(result).toEqual(
      expect.objectContaining({ id: "booking-1", status: BookingStatus.CANCELLED }),
    );
    expect(txMock.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "booking-1",
          userId: "user-1",
          status: BookingStatus.CONFIRMED,
          paymentStatus: PaymentStatus.PAID,
        }),
        data: expect.objectContaining({
          status: BookingStatus.CANCELLED,
          paymentStatus: PaymentStatus.REFUND_PROCESSING,
          cancellationReason: "User requested cancellation",
          referralCreditsReserved: 0,
          referralCreditsUsed: 0,
        }),
      }),
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
    txMock.booking.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      service.cancelBooking("booking-1", "user-1", "User requested cancellation"),
    ).rejects.toBeInstanceOf(BookingStatusNotModifiableException);
    expect(txMock.booking.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("throws BookingCancellationFailedException when transaction fails unexpectedly", async () => {
    databaseServiceMock.$transaction.mockRejectedValueOnce(new Error("Transaction failed"));

    await expect(
      service.cancelBooking("booking-1", "user-1", "User requested cancellation"),
    ).rejects.toBeInstanceOf(BookingCancellationFailedException);
  });
});
