import { Test, type TestingModule } from "@nestjs/testing";
import { BookingStatus, PaymentStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseService } from "../database/database.service";
import { NotificationService } from "../notification/notification.service";
import {
  BookingCancellationFailedException,
  BookingNotCancellableException,
  BookingNotFoundException,
} from "./booking.error";
import { BookingCancellationService } from "./booking-cancellation.service";

describe("BookingCancellationService", () => {
  let service: BookingCancellationService;

  const txMock = {
    booking: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    car: {
      update: vi.fn(),
    },
  };

  const databaseServiceMock = {
    $transaction: vi.fn(),
  };
  const notificationServiceMock = {
    queueBookingCancellationNotifications: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    databaseServiceMock.$transaction.mockImplementation(
      async (callback: (transaction: typeof txMock) => unknown) => callback(txMock),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingCancellationService,
        { provide: DatabaseService, useValue: databaseServiceMock },
        { provide: NotificationService, useValue: notificationServiceMock },
      ],
    }).compile();

    service = module.get<BookingCancellationService>(BookingCancellationService);
  });

  it("cancels a paid booking and marks payment as refund processing", async () => {
    txMock.booking.findUnique.mockResolvedValueOnce({
      id: "booking-1",
      userId: "user-1",
      status: BookingStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID,
      carId: "car-1",
    });
    txMock.booking.update.mockResolvedValueOnce({
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
    expect(txMock.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "booking-1" },
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
    expect(notificationServiceMock.queueBookingCancellationNotifications).toHaveBeenCalledWith(
      expect.objectContaining({ id: "booking-1", status: BookingStatus.CANCELLED }),
    );
  });

  it("throws BookingNotFoundException when booking is missing or not owned by user", async () => {
    txMock.booking.findUnique.mockResolvedValueOnce(null);

    await expect(
      service.cancelBooking("missing-booking", "user-1", "User requested cancellation"),
    ).rejects.toBeInstanceOf(BookingNotFoundException);
  });

  it("throws BookingNotCancellableException when booking status is not cancellable", async () => {
    txMock.booking.findUnique.mockResolvedValueOnce({
      id: "booking-1",
      userId: "user-1",
      status: BookingStatus.COMPLETED,
      paymentStatus: PaymentStatus.PAID,
      carId: "car-1",
    });

    await expect(
      service.cancelBooking("booking-1", "user-1", "User requested cancellation"),
    ).rejects.toBeInstanceOf(BookingNotCancellableException);
  });

  it("throws BookingCancellationFailedException when transaction fails unexpectedly", async () => {
    databaseServiceMock.$transaction.mockRejectedValueOnce(new Error("Transaction failed"));

    await expect(
      service.cancelBooking("booking-1", "user-1", "User requested cancellation"),
    ).rejects.toBeInstanceOf(BookingCancellationFailedException);
  });
});
