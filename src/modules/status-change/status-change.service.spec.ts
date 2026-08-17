import { Test, TestingModule } from "@nestjs/testing";
import {
  BookingCompletionSource,
  BookingStatus,
  BookingType,
  DomainOutboxEventType,
  PaymentStatus,
  Status,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { createBooking, createCar } from "../../shared/helper.fixtures";
import { BookingNotFoundException } from "../booking/booking.error";
import { DatabaseService } from "../database/database.service";
import { DomainOutboxService } from "../domain-outbox/domain-outbox.service";
import { BookingStatusChangedHandler } from "../notification/handlers/booking-status-changed.handler";
import { NotificationOutboxService } from "../notification/notification-outbox.service";
import {
  ActiveToCompletedUpdateFailedException,
  AirportBookingActivationFailedException,
  ConfirmedToActiveUpdateFailedException,
} from "./status-change.error";
import { StatusChangeService } from "./status-change.service";

describe("StatusChangeService", () => {
  let service: StatusChangeService;
  let mockDatabaseService: DatabaseService;
  let mockNotificationOutboxService: NotificationOutboxService;
  let mockDomainOutboxService: DomainOutboxService;

  beforeEach(async () => {
    process.env.SESSION_SECRET = "test-secret-at-least-32-characters-long";
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StatusChangeService,
        {
          provide: DatabaseService,
          useValue: {
            booking: {
              findMany: vi.fn(),
              findUnique: vi.fn(),
              findUniqueOrThrow: vi.fn(),
              findFirst: vi.fn(),
              update: vi.fn(),
              updateMany: vi.fn(),
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
          provide: NotificationOutboxService,
          useValue: {
            create: vi.fn(),
          },
        },
        {
          provide: BookingStatusChangedHandler,
          useValue: {
            eventType: "BOOKING_LIFECYCLE",
            buildEvents: vi.fn(),
          },
        },
        {
          provide: DomainOutboxService,
          useValue: {
            createMany: vi.fn().mockResolvedValue(2),
          },
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get<StatusChangeService>(StatusChangeService);
    mockDatabaseService = module.get<DatabaseService>(DatabaseService);
    mockNotificationOutboxService =
      module.get<NotificationOutboxService>(NotificationOutboxService);
    mockDomainOutboxService = module.get<DomainOutboxService>(DomainOutboxService);
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
    expect(mockNotificationOutboxService.create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ eventType: "BOOKING_LIFECYCLE" }),
      expect.objectContaining({
        booking: expect.objectContaining({ id: "1", status: BookingStatus.ACTIVE }),
        oldStatus: BookingStatus.CONFIRMED,
        newStatus: BookingStatus.ACTIVE,
        showReviewRequest: false,
      }),
      mockDatabaseService,
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
    vi.mocked(mockNotificationOutboxService.create).mockRejectedValueOnce(
      new Error("Notification error"),
    );

    const result = await service.updateBookingsFromConfirmedToActive();

    expect(result).toBe("Updated 1 bookings from confirmed to active");
  });

  it("should throw error when booking query fails for confirmed to active", async () => {
    const error = new Error("Database error");
    vi.mocked(mockDatabaseService.booking.findMany).mockRejectedValueOnce(error);

    await expect(service.updateBookingsFromConfirmedToActive()).rejects.toBeInstanceOf(
      ConfirmedToActiveUpdateFailedException,
    );
  });

  it("should update bookings from active to completed when no bookings found", async () => {
    vi.mocked(mockDatabaseService.booking.findMany).mockResolvedValue([]);

    const result = await service.updateBookingsFromActiveToCompleted();

    expect(mockDatabaseService.booking.findMany).toHaveBeenCalledWith({
      where: {
        status: BookingStatus.ACTIVE,
        paymentStatus: PaymentStatus.PAID,
        type: { not: BookingType.AIRPORT_PICKUP },
        endDate: { lte: expect.any(Date) },
        car: { status: Status.BOOKED },
      },
      include: {
        car: { include: { owner: true } },
        user: true,
        chauffeur: true,
        legs: { include: { extensions: true } },
      },
    });
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

    const bookingFindFirstMock = vi.fn().mockResolvedValue(null);
    const carUpdateMock = vi.fn().mockResolvedValue({ id: "car-1", status: Status.AVAILABLE });

    const reviewFindUniqueMock = vi.fn().mockResolvedValue(null);

    vi.mocked(mockDatabaseService.booking.updateMany).mockResolvedValueOnce({ count: 1 });
    vi.mocked(mockDatabaseService.booking.findUniqueOrThrow).mockResolvedValue({
      ...mockBooking,
      status: BookingStatus.COMPLETED,
    });
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
    expect(mockNotificationOutboxService.create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ eventType: "BOOKING_LIFECYCLE" }),
      expect.objectContaining({
        booking: expect.objectContaining({ id: "2", status: BookingStatus.COMPLETED }),
        oldStatus: BookingStatus.ACTIVE,
        newStatus: BookingStatus.COMPLETED,
        showReviewRequest: true, // showReviewRequest should be true when no review exists
      }),
      mockDatabaseService,
    );
    expect(mockDomainOutboxService.createMany).toHaveBeenCalledExactlyOnceWith(
      [
        {
          eventType: DomainOutboxEventType.REFERRAL_COMPLETION,
          aggregateId: "2",
        },
        {
          eventType: DomainOutboxEventType.PAYOUT_PROCESSING,
          aggregateId: "2",
        },
      ],
      mockDatabaseService,
    );
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
    vi.mocked(mockDatabaseService.booking.updateMany).mockResolvedValueOnce({ count: 1 });
    vi.mocked(mockDatabaseService.booking.findUniqueOrThrow).mockResolvedValue({
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
    vi.mocked(mockNotificationOutboxService.create).mockRejectedValueOnce(
      new Error("Notification error"),
    );

    const result = await service.updateBookingsFromActiveToCompleted();

    expect(result).toBe("Updated 1 bookings from active to completed");
  });

  it("should fail completion when durable domain deliveries cannot be recorded", async () => {
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
    vi.mocked(mockDatabaseService.booking.updateMany).mockResolvedValueOnce({ count: 1 });
    vi.mocked(mockDatabaseService.booking.findUniqueOrThrow).mockResolvedValue({
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
    vi.mocked(mockDomainOutboxService.createMany).mockRejectedValueOnce(
      new Error("Domain outbox unavailable"),
    );

    await expect(service.updateBookingsFromActiveToCompleted()).rejects.toThrow(
      ActiveToCompletedUpdateFailedException,
    );
  });

  it("should activate a single eligible airport booking", async () => {
    const mockBooking = createBooking({
      id: "airport-1",
      type: "AIRPORT_PICKUP",
      status: BookingStatus.ACTIVE,
      paymentStatus: PaymentStatus.PAID,
      chauffeurId: "chauffeur-1",
      car: createCar({ status: Status.BOOKED }),
    });

    vi.mocked(mockDatabaseService.booking.updateMany).mockResolvedValueOnce({ count: 1 });
    vi.mocked(mockDatabaseService.booking.findUnique).mockResolvedValueOnce(mockBooking);

    const result = await service.activateAirportBooking("airport-1", new Date().toISOString());

    expect(mockDatabaseService.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "airport-1",
          status: BookingStatus.CONFIRMED,
          paymentStatus: PaymentStatus.PAID,
          airportScheduleConflictAt: null,
        }),
        data: {
          status: BookingStatus.ACTIVE,
          completionTokenHash: expect.any(String),
          completionTokenExpiresAt: expect.any(Date),
        },
      }),
    );
    expect(mockDatabaseService.booking.findUnique).toHaveBeenCalledWith({
      where: { id: "airport-1" },
      include: {
        car: { include: { owner: true } },
        user: true,
        chauffeur: true,
        legs: { include: { extensions: true } },
      },
    });
    expect(mockNotificationOutboxService.create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ eventType: "BOOKING_LIFECYCLE" }),
      expect.objectContaining({
        booking: expect.objectContaining({ id: "airport-1", status: BookingStatus.ACTIVE }),
        oldStatus: BookingStatus.CONFIRMED,
        newStatus: BookingStatus.ACTIVE,
        showReviewRequest: false,
        includeChauffeurCompletionLink: true,
      }),
      undefined,
    );
    expect(result).toBe("Activated airport booking airport-1");
  });

  it("completes an active airport booking with its chauffeur token", async () => {
    const completedAt = new Date("2026-08-17T12:00:00.000Z");
    const booking = createBooking({
      id: "airport-complete-1",
      type: BookingType.AIRPORT_PICKUP,
      status: BookingStatus.ACTIVE,
      paymentStatus: PaymentStatus.PAID,
      chauffeurId: "chauffeur-1",
      completionTokenHash: "token-hash",
      completionTokenExpiresAt: new Date("2099-08-17T12:00:00.000Z"),
      completedAt: null,
      car: createCar({ id: "car-airport", status: Status.BOOKED }),
    });
    const completedBooking = {
      ...booking,
      status: BookingStatus.COMPLETED,
      completedAt,
      completionSource: BookingCompletionSource.CHAUFFEUR_LINK,
      completedByUserId: "chauffeur-1",
    };
    vi.mocked(mockDatabaseService.booking.findFirst)
      .mockResolvedValueOnce(booking)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(completedBooking);
    vi.mocked(mockDatabaseService.booking.updateMany).mockResolvedValueOnce({ count: 1 });
    vi.mocked(mockDatabaseService.booking.findUniqueOrThrow).mockResolvedValueOnce(
      completedBooking,
    );
    vi.mocked(mockDatabaseService.review.findUnique).mockResolvedValueOnce(null);
    vi.mocked(mockDatabaseService.$transaction).mockImplementation(
      async <T>(callback: (tx: DatabaseService) => Promise<T>): Promise<T> =>
        callback(mockDatabaseService),
    );

    const result = await service.completeAirportBookingWithToken(
      "airport-complete-1",
      "token-hash",
    );
    const repeatedResult = await service.completeAirportBookingWithToken(
      "airport-complete-1",
      "token-hash",
    );

    expect(mockDatabaseService.booking.findFirst).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          id: "airport-complete-1",
          status: { in: [BookingStatus.ACTIVE, BookingStatus.COMPLETED] },
          completionTokenHash: "token-hash",
          completionTokenExpiresAt: { gt: expect.any(Date) },
        }),
      }),
    );
    expect(mockDatabaseService.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: BookingStatus.COMPLETED,
          completedByUserId: "chauffeur-1",
          completionSource: BookingCompletionSource.CHAUFFEUR_LINK,
        }),
      }),
    );
    expect(mockDatabaseService.booking.updateMany).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      id: "airport-complete-1",
      status: BookingStatus.COMPLETED,
      completedAt,
    });
    expect(repeatedResult).toMatchObject({
      id: "airport-complete-1",
      status: BookingStatus.COMPLETED,
      completedAt,
    });
  });

  it("rejects an expired chauffeur completion token", async () => {
    vi.mocked(mockDatabaseService.booking.findFirst).mockResolvedValueOnce(null);

    await expect(
      service.getAirportCompletionDetails("airport-complete-1", "expired-token-hash"),
    ).rejects.toBeInstanceOf(BookingNotFoundException);

    expect(mockDatabaseService.booking.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: [BookingStatus.ACTIVE, BookingStatus.COMPLETED] },
          completionTokenHash: "expired-token-hash",
          completionTokenExpiresAt: { gt: expect.any(Date) },
        }),
      }),
    );
  });

  it("rejects a fleet owner who does not own the airport booking", async () => {
    vi.mocked(mockDatabaseService.booking.findFirst).mockResolvedValueOnce(null);
    vi.mocked(mockDatabaseService.$transaction).mockImplementation(
      async <T>(callback: (tx: DatabaseService) => Promise<T>): Promise<T> =>
        callback(mockDatabaseService),
    );

    await expect(
      service.completeAirportBookingForUser(
        "airport-complete-1",
        "wrong-owner",
        BookingCompletionSource.FLEET_OWNER,
      ),
    ).rejects.toBeInstanceOf(BookingNotFoundException);
    expect(mockDatabaseService.booking.updateMany).not.toHaveBeenCalled();
  });

  it("allows operations to complete an airport booking without an ownership filter", async () => {
    const completedBooking = createBooking({
      id: "airport-complete-1",
      type: BookingType.AIRPORT_PICKUP,
      status: BookingStatus.COMPLETED,
      paymentStatus: PaymentStatus.PAID,
      completedAt: new Date("2026-08-17T12:00:00.000Z"),
      car: createCar({ id: "car-airport" }),
    });
    vi.mocked(mockDatabaseService.booking.findFirst).mockResolvedValueOnce(completedBooking);
    vi.mocked(mockDatabaseService.$transaction).mockImplementation(
      async <T>(callback: (tx: DatabaseService) => Promise<T>): Promise<T> =>
        callback(mockDatabaseService),
    );

    await service.completeAirportBookingForUser(
      "airport-complete-1",
      "operations-user",
      BookingCompletionSource.OPERATIONS,
    );

    expect(mockDatabaseService.booking.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.not.objectContaining({ car: expect.anything() }),
      }),
    );
    expect(mockDatabaseService.booking.updateMany).not.toHaveBeenCalled();
  });

  it("should skip airport activation when updated booking cannot be refetched", async () => {
    const timestamp = new Date().toISOString();
    vi.mocked(mockDatabaseService.booking.updateMany).mockResolvedValueOnce({ count: 1 });
    vi.mocked(mockDatabaseService.booking.findUnique).mockResolvedValueOnce(null);

    const result = await service.activateAirportBooking("airport-3", timestamp);

    expect(mockDatabaseService.booking.findUnique).toHaveBeenCalledWith({
      where: { id: "airport-3" },
      include: {
        car: { include: { owner: true } },
        user: true,
        chauffeur: true,
        legs: { include: { extensions: true } },
      },
    });
    expect(result).toBe("Skipped airport activation for airport-3: booking not found");
  });

  it("should skip airport activation when booking is not eligible", async () => {
    vi.mocked(mockDatabaseService.booking.updateMany).mockResolvedValueOnce({ count: 0 });

    const result = await service.activateAirportBooking("airport-2", new Date().toISOString());

    expect(mockDatabaseService.booking.findUnique).not.toHaveBeenCalled();
    expect(result).toBe("Skipped airport activation for airport-2: booking not eligible");
  });

  it("should throw when airport activation bookingId is missing", async () => {
    await expect(
      service.activateAirportBooking(undefined as unknown as string, new Date().toISOString()),
    ).rejects.toBeInstanceOf(AirportBookingActivationFailedException);
    expect(mockDatabaseService.booking.updateMany).not.toHaveBeenCalled();
  });
});
