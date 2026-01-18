import { Test, TestingModule } from "@nestjs/testing";
import { BookingStatus, PaymentStatus, Status } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBooking, createCar } from "../../shared/helper.fixtures";
import { DatabaseService } from "../database/database.service";
import { NotificationService } from "../notification/notification.service";
import { PaymentService } from "../payment/payment.service";
import { ReferralService } from "../referral/referral.service";
import { StatusChangeService } from "./status-change.service";

describe("StatusChangeService", () => {
  let service: StatusChangeService;
  let mockDatabaseService: DatabaseService;
  let mockNotificationService: NotificationService;
  let mockPaymentService: PaymentService;
  let mockReferralService: ReferralService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StatusChangeService,
        {
          provide: DatabaseService,
          useValue: {
            booking: {
              findMany: vi.fn(),
              findUnique: vi.fn(),
              findFirst: vi.fn(),
              update: vi.fn(),
            },
            car: {
              update: vi.fn(),
            },
            review: {
              findUnique: vi.fn(),
            },
            $transaction: vi.fn(),
          },
        },
        {
          provide: NotificationService,
          useValue: {
            queueBookingStatusNotifications: vi.fn(),
          },
        },
        {
          provide: ReferralService,
          useValue: {
            queueReferralProcessing: vi.fn(),
          },
        },
        {
          provide: PaymentService,
          useValue: {
            queuePayoutForBooking: vi.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<StatusChangeService>(StatusChangeService);
    mockDatabaseService = module.get<DatabaseService>(DatabaseService);
    mockNotificationService = module.get<NotificationService>(NotificationService);
    mockPaymentService = module.get<PaymentService>(PaymentService);
    mockReferralService = module.get<ReferralService>(ReferralService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  it("should have all required services injected", () => {
    expect(service).toBeDefined();
    expect(mockDatabaseService).toBeDefined();
    expect(mockNotificationService).toBeDefined();
    expect(mockPaymentService).toBeDefined();
    expect(mockReferralService).toBeDefined();
  });

  it("should not update bookings from confirmed to active when no bookings found", async () => {
    vi.mocked(mockDatabaseService.booking.findMany).mockResolvedValue([]);
    const result = await service.updateBookingsFromConfirmedToActive();

    expect(mockDatabaseService.booking.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        status: BookingStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
        chauffeurId: { not: null },
        startDate: {
          gte: expect.any(Date),
          lte: expect.any(Date),
        },
        car: { status: Status.BOOKED },
      }),
      include: {
        car: { include: { owner: true } },
        user: true,
        chauffeur: true,
        legs: { include: { extensions: true } },
      },
    });
    expect(result).toEqual("No bookings to update");
  });

  it("should update bookings from confirmed to active when bookings found", async () => {
    const mockBooking = createBooking({
      id: "1",
      status: BookingStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID,
    });

    vi.mocked(mockDatabaseService.booking.findMany).mockResolvedValue([mockBooking]);

    const bookingUpdateMock = vi
      .fn()
      .mockResolvedValue({ ...mockBooking, status: BookingStatus.ACTIVE });
    vi.mocked(mockDatabaseService.booking.update).mockImplementation(bookingUpdateMock);

    vi.mocked(mockDatabaseService.$transaction).mockImplementation(
      async <T>(callback: (tx: DatabaseService) => Promise<T>): Promise<T> => {
        return callback(mockDatabaseService);
      },
    );

    const result = await service.updateBookingsFromConfirmedToActive();

    expect(mockDatabaseService.$transaction).toHaveBeenCalledOnce();
    expect(mockNotificationService.queueBookingStatusNotifications).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "1", status: BookingStatus.ACTIVE }),
      BookingStatus.CONFIRMED,
      BookingStatus.ACTIVE,
    );
    expect(result).toBe("Updated 1 bookings from confirmed to active");
  });

  it("should continue when status notification queue fails for confirmed to active", async () => {
    const mockBooking = createBooking({
      id: "1",
      status: BookingStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID,
    });

    vi.mocked(mockDatabaseService.booking.findMany).mockResolvedValue([mockBooking]);
    vi.mocked(mockDatabaseService.booking.update).mockResolvedValue({
      ...mockBooking,
      status: BookingStatus.ACTIVE,
    });
    vi.mocked(mockDatabaseService.$transaction).mockImplementation(
      async <T>(callback: (tx: DatabaseService) => Promise<T>): Promise<T> =>
        callback(mockDatabaseService),
    );
    vi.mocked(mockNotificationService.queueBookingStatusNotifications).mockRejectedValueOnce(
      new Error("Notification error"),
    );

    const result = await service.updateBookingsFromConfirmedToActive();

    expect(result).toBe("Updated 1 bookings from confirmed to active");
  });

  it("should throw error when booking query fails for confirmed to active", async () => {
    const error = new Error("Database error");
    vi.mocked(mockDatabaseService.booking.findMany).mockRejectedValueOnce(error);

    await expect(service.updateBookingsFromConfirmedToActive()).rejects.toThrow(error);
  });

  it("should update bookings from active to completed when no bookings found", async () => {
    vi.mocked(mockDatabaseService.booking.findMany).mockResolvedValue([]);

    const result = await service.updateBookingsFromActiveToCompleted();

    expect(result).toBe("No bookings to update");
  });

  it("should update bookings from active to completed and queue referral processing", async () => {
    const mockCar = createCar({
      id: "car-1",
      status: Status.BOOKED,
    });

    const mockBooking = createBooking({
      id: "2",
      status: BookingStatus.ACTIVE,
      paymentStatus: PaymentStatus.PAID,
      carId: "car-1",
      car: mockCar,
    });

    vi.mocked(mockDatabaseService.booking.findMany).mockResolvedValue([mockBooking]);

    const bookingUpdateMock = vi
      .fn()
      .mockResolvedValue({ ...mockBooking, status: BookingStatus.COMPLETED });
    const bookingFindFirstMock = vi.fn().mockResolvedValue(null);
    const carUpdateMock = vi.fn().mockResolvedValue({ id: "car-1", status: Status.AVAILABLE });

    const reviewFindUniqueMock = vi.fn().mockResolvedValue(null);

    vi.mocked(mockDatabaseService.booking.update).mockImplementation(bookingUpdateMock);
    vi.mocked(mockDatabaseService.booking.findFirst).mockImplementation(bookingFindFirstMock);
    vi.mocked(mockDatabaseService.car.update).mockImplementation(carUpdateMock);
    vi.mocked(mockDatabaseService.review.findUnique).mockImplementation(reviewFindUniqueMock);

    vi.mocked(mockDatabaseService.$transaction).mockImplementation(
      async <T>(callback: (tx: DatabaseService) => Promise<T>): Promise<T> => {
        return callback(mockDatabaseService);
      },
    );

    const result = await service.updateBookingsFromActiveToCompleted();

    expect(mockDatabaseService.$transaction).toHaveBeenCalledOnce();
    expect(bookingFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          carId: "car-1",
          status: BookingStatus.CONFIRMED,
        }),
      }),
    );
    expect(carUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: Status.AVAILABLE }),
      }),
    );

    expect(reviewFindUniqueMock).toHaveBeenCalledWith({
      where: { bookingId: "2" },
    });
    expect(mockNotificationService.queueBookingStatusNotifications).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "2", status: BookingStatus.COMPLETED }),
      BookingStatus.ACTIVE,
      BookingStatus.COMPLETED,
      true, // showReviewRequest should be true when no review exists
    );
    expect(mockReferralService.queueReferralProcessing).toHaveBeenCalledExactlyOnceWith("2");
    expect(mockPaymentService.queuePayoutForBooking).toHaveBeenCalledExactlyOnceWith("2");
    expect(result).toBe("Updated 1 bookings from active to completed");
  });

  it("should continue when status notification queue fails for active to completed", async () => {
    const mockCar = createCar({
      id: "car-2",
      status: Status.BOOKED,
    });

    const mockBooking = createBooking({
      id: "3",
      status: BookingStatus.ACTIVE,
      paymentStatus: PaymentStatus.PAID,
      carId: "car-2",
      car: mockCar,
    });

    vi.mocked(mockDatabaseService.booking.findMany).mockResolvedValue([mockBooking]);
    vi.mocked(mockDatabaseService.booking.update).mockResolvedValue({
      ...mockBooking,
      status: BookingStatus.COMPLETED,
    });
    vi.mocked(mockDatabaseService.booking.findFirst).mockResolvedValue(null);
    vi.mocked(mockDatabaseService.car.update).mockResolvedValue(
      createCar({ id: "car-2", status: Status.AVAILABLE }),
    );
    vi.mocked(mockDatabaseService.review.findUnique).mockResolvedValue(null);
    vi.mocked(mockDatabaseService.$transaction).mockImplementation(
      async <T>(callback: (tx: DatabaseService) => Promise<T>): Promise<T> =>
        callback(mockDatabaseService),
    );
    vi.mocked(mockNotificationService.queueBookingStatusNotifications).mockRejectedValueOnce(
      new Error("Notification error"),
    );

    const result = await service.updateBookingsFromActiveToCompleted();

    expect(result).toBe("Updated 1 bookings from active to completed");
  });

  it("should continue when referral or payout queueing fails", async () => {
    const mockCar = createCar({
      id: "car-3",
      status: Status.BOOKED,
    });

    const mockBooking = createBooking({
      id: "4",
      status: BookingStatus.ACTIVE,
      paymentStatus: PaymentStatus.PAID,
      carId: "car-3",
      car: mockCar,
    });

    vi.mocked(mockDatabaseService.booking.findMany).mockResolvedValue([mockBooking]);
    vi.mocked(mockDatabaseService.booking.update).mockResolvedValue({
      ...mockBooking,
      status: BookingStatus.COMPLETED,
    });
    vi.mocked(mockDatabaseService.booking.findFirst).mockResolvedValue(null);
    vi.mocked(mockDatabaseService.car.update).mockResolvedValue(
      createCar({ id: "car-3", status: Status.AVAILABLE }),
    );
    vi.mocked(mockDatabaseService.review.findUnique).mockResolvedValue(null);
    vi.mocked(mockDatabaseService.$transaction).mockImplementation(
      async <T>(callback: (tx: DatabaseService) => Promise<T>): Promise<T> =>
        callback(mockDatabaseService),
    );
    vi.mocked(mockReferralService.queueReferralProcessing).mockRejectedValueOnce(
      new Error("Referral queue error"),
    );
    vi.mocked(mockPaymentService.queuePayoutForBooking).mockRejectedValueOnce(
      new Error("Payout queue error"),
    );

    const result = await service.updateBookingsFromActiveToCompleted();

    expect(mockReferralService.queueReferralProcessing).toHaveBeenCalledExactlyOnceWith("4");
    expect(mockPaymentService.queuePayoutForBooking).toHaveBeenCalledExactlyOnceWith("4");
    expect(result).toBe("Updated 1 bookings from active to completed");
  });
});
