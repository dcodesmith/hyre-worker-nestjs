import { getQueueToken } from "@nestjs/bullmq";
import { Test, TestingModule } from "@nestjs/testing";
import type { Payment } from "@prisma/client";
import { BookingStatus, PaymentAttemptStatus, PaymentStatus, Status } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import type { Job, Queue } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NOTIFICATIONS_QUEUE } from "../../config/constants";
import { createBooking, createCar, createOwner, createUser } from "../../shared/helper.fixtures";
import type { BookingWithRelations } from "../../types";
import { DatabaseService } from "../database/database.service";
import type { NotificationJobData } from "../notification/notification.interface";
import { NotificationType } from "../notification/notification.interface";
import { BookingConfirmationService } from "./booking-confirmation.service";

// Minimal mock Job object for queue.add() return value
const createMockJob = (): Job<NotificationJobData> =>
  ({
    id: "mock-job-id",
    name: "send-notification",
    data: {} as NotificationJobData,
    opts: {},
    progress: 0,
    returnvalue: null,
    stacktrace: [],
    attemptsMade: 0,
    attemptsStarted: 0,
    timestamp: Date.now(),
    queueQualifiedName: `bull:${NOTIFICATIONS_QUEUE}`,
  }) as Job<NotificationJobData>;

// Helper to create mock Payment objects with required fields for testing
function createMockPayment(overrides: Partial<Payment>): Payment {
  return {
    id: "payment-123",
    bookingId: "booking-123",
    extensionId: null,
    txRef: "tx-ref-123",
    flutterwaveTransactionId: "12345",
    flutterwaveReference: null,
    amountExpected: new Decimal(10000),
    amountCharged: new Decimal(10000),
    currency: "NGN",
    feeChargedByProvider: null,
    status: PaymentAttemptStatus.SUCCESSFUL,
    paymentProviderStatus: null,
    paymentMethod: null,
    initiatedAt: new Date(),
    confirmedAt: new Date(),
    lastVerifiedAt: null,
    webhookPayload: null,
    verificationResponse: null,
    refundIdempotencyKey: null,
    ...overrides,
  };
}

// Helper to create mock BookingWithRelations for testing using fixtures
function createMockBookingWithRelations(
  overrides: Partial<BookingWithRelations> = {},
): BookingWithRelations {
  return createBooking({
    status: BookingStatus.PENDING,
    paymentStatus: PaymentStatus.UNPAID,
    user: createUser(),
    car: createCar(),
    chauffeur: null,
    legs: [],
    ...overrides,
  });
}

describe("BookingConfirmationService", () => {
  let service: BookingConfirmationService;
  let databaseService: DatabaseService;
  let notificationQueue: Queue;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingConfirmationService,
        {
          provide: DatabaseService,
          useValue: {
            booking: {
              findUnique: vi.fn(),
              updateMany: vi.fn(),
            },
            car: {
              update: vi.fn(),
            },
          },
        },
        {
          provide: getQueueToken(NOTIFICATIONS_QUEUE),
          useValue: {
            add: vi.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<BookingConfirmationService>(BookingConfirmationService);
    databaseService = module.get<DatabaseService>(DatabaseService);
    notificationQueue = module.get<Queue>(getQueueToken(NOTIFICATIONS_QUEUE));
  });
  describe("confirmFromPayment", () => {
    it("should confirm a PENDING booking and update to CONFIRMED", async () => {
      const mockPayment = createMockPayment({
        id: "payment-123",
        bookingId: "booking-123",
        txRef: "tx-ref-123",
      });
      const mockBooking = createMockBookingWithRelations({
        id: "booking-123",
        status: BookingStatus.CONFIRMED, // After update
        paymentStatus: PaymentStatus.PAID,
      });

      // Atomic conditional update succeeds (1 row updated)
      vi.mocked(databaseService.booking.updateMany).mockResolvedValueOnce({ count: 1 });
      // Fetch updated booking with relations
      vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(mockBooking);
      vi.mocked(databaseService.car.update).mockResolvedValueOnce(mockBooking.car);
      vi.mocked(notificationQueue.add).mockResolvedValue(createMockJob());

      const result = await service.confirmFromPayment(mockPayment);

      expect(result).toBe(true);
      expect(databaseService.booking.updateMany).toHaveBeenCalledWith({
        where: { id: "booking-123", status: BookingStatus.PENDING },
        data: {
          status: BookingStatus.CONFIRMED,
          paymentStatus: PaymentStatus.PAID,
        },
      });
      expect(databaseService.booking.findUnique).toHaveBeenCalledWith({
        where: { id: "booking-123" },
        include: {
          chauffeur: true,
          user: true,
          car: { include: { owner: true } },
          legs: { include: { extensions: true } },
        },
      });
    });

    it("should queue booking confirmation notification after confirmation", async () => {
      const mockPayment = createMockPayment({
        id: "payment-123",
        bookingId: "booking-123",
      });
      const mockBooking = createMockBookingWithRelations({
        id: "booking-123",
        status: BookingStatus.CONFIRMED, // After update
      });

      vi.mocked(databaseService.booking.updateMany).mockResolvedValueOnce({ count: 1 });
      vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(mockBooking);
      vi.mocked(databaseService.car.update).mockResolvedValueOnce(mockBooking.car);
      vi.mocked(notificationQueue.add).mockResolvedValue(createMockJob());

      await service.confirmFromPayment(mockPayment);

      expect(notificationQueue.add).toHaveBeenCalledWith(
        "send-notification",
        expect.objectContaining({
          type: NotificationType.BOOKING_CONFIRMED,
          bookingId: "booking-123",
          templateData: expect.objectContaining({
            subject: "Your booking is confirmed!",
          }),
        }),
        { priority: 1 },
      );
    });

    it("should return false when payment has no bookingId", async () => {
      const mockPayment = createMockPayment({
        id: "payment-123",
        bookingId: null,
        txRef: "tx-ref-123",
      });

      const result = await service.confirmFromPayment(mockPayment);

      expect(result).toBe(false);
      expect(databaseService.booking.updateMany).not.toHaveBeenCalled();
      expect(databaseService.booking.findUnique).not.toHaveBeenCalled();
    });

    it("should return false when booking is not found", async () => {
      const mockPayment = createMockPayment({
        id: "payment-123",
        bookingId: "non-existent-booking",
      });

      // Atomic conditional update returns 0 when booking not found
      vi.mocked(databaseService.booking.updateMany).mockResolvedValueOnce({ count: 0 });

      const result = await service.confirmFromPayment(mockPayment);

      expect(result).toBe(false);
      expect(databaseService.booking.findUnique).not.toHaveBeenCalled();
    });

    it("should return false when booking is not in PENDING status", async () => {
      const mockPayment = createMockPayment({
        id: "payment-123",
        bookingId: "booking-123",
      });

      // Atomic conditional update returns 0 when booking is not in PENDING status
      vi.mocked(databaseService.booking.updateMany).mockResolvedValueOnce({ count: 0 });

      const result = await service.confirmFromPayment(mockPayment);

      expect(result).toBe(false);
      expect(databaseService.booking.findUnique).not.toHaveBeenCalled();
    });

    it.each([
      BookingStatus.ACTIVE,
      BookingStatus.COMPLETED,
      BookingStatus.CANCELLED,
      BookingStatus.REJECTED,
    ])("should return false when booking is in %s status (idempotency)", async () => {
      const mockPayment = createMockPayment({
        id: "payment-123",
        bookingId: "booking-123",
      });

      // Atomic conditional update returns 0 when booking is not in PENDING status
      vi.mocked(databaseService.booking.updateMany).mockResolvedValueOnce({ count: 0 });

      const result = await service.confirmFromPayment(mockPayment);

      expect(result).toBe(false);
      expect(databaseService.booking.findUnique).not.toHaveBeenCalled();
    });

    it("should not fail confirmation if notification queueing fails", async () => {
      const mockPayment = createMockPayment({
        id: "payment-123",
        bookingId: "booking-123",
      });
      const mockBooking = createMockBookingWithRelations({
        id: "booking-123",
        status: BookingStatus.CONFIRMED, // After update
      });

      vi.mocked(databaseService.booking.updateMany).mockResolvedValueOnce({ count: 1 });
      vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(mockBooking);
      vi.mocked(databaseService.car.update).mockResolvedValueOnce(mockBooking.car);
      vi.mocked(notificationQueue.add).mockRejectedValue(new Error("Queue connection failed"));

      // Should not throw, should still return true
      const result = await service.confirmFromPayment(mockPayment);

      expect(result).toBe(true);
      expect(databaseService.booking.updateMany).toHaveBeenCalled();
    });

    it("should queue fleet owner notification when owner has email", async () => {
      const mockPayment = createMockPayment({
        id: "payment-123",
        bookingId: "booking-123",
      });
      const mockBooking = createMockBookingWithRelations({
        id: "booking-123",
        status: BookingStatus.CONFIRMED,
        car: createCar({
          owner: createOwner({
            email: "owner@example.com",
            phoneNumber: null,
          }),
        }),
      });

      vi.mocked(databaseService.booking.updateMany).mockResolvedValueOnce({ count: 1 });
      vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(mockBooking);
      vi.mocked(databaseService.car.update).mockResolvedValueOnce(mockBooking.car);
      vi.mocked(notificationQueue.add).mockResolvedValue(createMockJob());

      await service.confirmFromPayment(mockPayment);

      // Should queue both customer and fleet owner notifications
      expect(notificationQueue.add).toHaveBeenCalledTimes(2);

      // Check fleet owner notification
      expect(notificationQueue.add).toHaveBeenCalledWith(
        "send-notification",
        expect.objectContaining({
          type: NotificationType.FLEET_OWNER_NEW_BOOKING,
          bookingId: "booking-123",
          recipients: expect.objectContaining({
            fleetOwner: expect.objectContaining({
              email: "owner@example.com",
            }),
          }),
          templateData: expect.objectContaining({
            subject: "New Booking Alert",
          }),
        }),
        { priority: 1 },
      );
    });

    it("should queue fleet owner notification when owner has phone number", async () => {
      const mockPayment = createMockPayment({
        id: "payment-123",
        bookingId: "booking-123",
      });
      const mockBooking = createMockBookingWithRelations({
        id: "booking-123",
        status: BookingStatus.CONFIRMED,
        car: createCar({
          owner: createOwner({
            email: null,
            phoneNumber: "+2348012345678",
          }),
        }),
      });

      vi.mocked(databaseService.booking.updateMany).mockResolvedValueOnce({ count: 1 });
      vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(mockBooking);
      vi.mocked(databaseService.car.update).mockResolvedValueOnce(mockBooking.car);
      vi.mocked(notificationQueue.add).mockResolvedValue(createMockJob());

      await service.confirmFromPayment(mockPayment);

      // Should queue both customer and fleet owner notifications
      expect(notificationQueue.add).toHaveBeenCalledTimes(2);

      // Check fleet owner notification has phone number
      expect(notificationQueue.add).toHaveBeenCalledWith(
        "send-notification",
        expect.objectContaining({
          type: NotificationType.FLEET_OWNER_NEW_BOOKING,
          recipients: expect.objectContaining({
            fleetOwner: expect.objectContaining({
              phoneNumber: "+2348012345678",
            }),
          }),
        }),
        { priority: 1 },
      );
    });

    it("should not queue fleet owner notification when owner has no contact info", async () => {
      const mockPayment = createMockPayment({
        id: "payment-123",
        bookingId: "booking-123",
      });
      const mockBooking = createMockBookingWithRelations({
        id: "booking-123",
        status: BookingStatus.CONFIRMED,
        car: createCar({
          owner: createOwner({
            email: null,
            phoneNumber: null,
          }),
        }),
      });

      vi.mocked(databaseService.booking.updateMany).mockResolvedValueOnce({ count: 1 });
      vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(mockBooking);
      vi.mocked(databaseService.car.update).mockResolvedValueOnce(mockBooking.car);
      vi.mocked(notificationQueue.add).mockResolvedValue(createMockJob());

      await service.confirmFromPayment(mockPayment);

      // Should only queue customer notification, not fleet owner
      expect(notificationQueue.add).toHaveBeenCalledTimes(1);
      expect(notificationQueue.add).toHaveBeenCalledWith(
        "send-notification",
        expect.objectContaining({
          type: NotificationType.BOOKING_CONFIRMED,
        }),
        { priority: 1 },
      );
    });

    it("should not fail confirmation if fleet owner notification queueing fails", async () => {
      const mockPayment = createMockPayment({
        id: "payment-123",
        bookingId: "booking-123",
      });
      const mockBooking = createMockBookingWithRelations({
        id: "booking-123",
        status: BookingStatus.CONFIRMED,
      });

      vi.mocked(databaseService.booking.updateMany).mockResolvedValueOnce({ count: 1 });
      vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(mockBooking);
      vi.mocked(databaseService.car.update).mockResolvedValueOnce(mockBooking.car);
      // First call (customer notification) succeeds, second call (fleet owner) fails
      vi.mocked(notificationQueue.add)
        .mockResolvedValueOnce(createMockJob())
        .mockRejectedValueOnce(new Error("Queue connection failed"));

      // Should not throw, should still return true
      const result = await service.confirmFromPayment(mockPayment);

      expect(result).toBe(true);
    });

    it("should update car status to BOOKED after booking confirmation", async () => {
      const mockPayment = createMockPayment({
        id: "payment-123",
        bookingId: "booking-123",
      });
      const mockBooking = createMockBookingWithRelations({
        id: "booking-123",
        carId: "car-456",
        status: BookingStatus.CONFIRMED,
      });

      vi.mocked(databaseService.booking.updateMany).mockResolvedValueOnce({ count: 1 });
      vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(mockBooking);
      vi.mocked(databaseService.car.update).mockResolvedValueOnce({
        ...mockBooking.car,
        status: Status.BOOKED,
      });
      vi.mocked(notificationQueue.add).mockResolvedValue(createMockJob());

      await service.confirmFromPayment(mockPayment);

      expect(databaseService.car.update).toHaveBeenCalledWith({
        where: { id: mockBooking.carId },
        data: { status: Status.BOOKED },
      });
    });

    it("should not fail confirmation if car status update fails", async () => {
      const mockPayment = createMockPayment({
        id: "payment-123",
        bookingId: "booking-123",
      });
      const mockBooking = createMockBookingWithRelations({
        id: "booking-123",
        status: BookingStatus.CONFIRMED,
      });

      vi.mocked(databaseService.booking.updateMany).mockResolvedValueOnce({ count: 1 });
      vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(mockBooking);
      vi.mocked(databaseService.car.update).mockRejectedValueOnce(new Error("Car update failed"));
      vi.mocked(notificationQueue.add).mockResolvedValue(createMockJob());

      // Should not throw, should still return true
      const result = await service.confirmFromPayment(mockPayment);

      expect(result).toBe(true);
      // Notifications should still be queued
      expect(notificationQueue.add).toHaveBeenCalled();
    });
  });
});
