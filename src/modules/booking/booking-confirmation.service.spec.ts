import { getQueueToken } from "@nestjs/bullmq";
import { Test, TestingModule } from "@nestjs/testing";
import type { Payment } from "@prisma/client";
import { BookingStatus, PaymentAttemptStatus, PaymentStatus } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { Queue } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NOTIFICATIONS_QUEUE } from "../../config/constants";
import {
  createBooking,
  createCar,
  createUser,
} from "../../shared/helper.fixtures";
import type { BookingWithRelations } from "../../types";
import { DatabaseService } from "../database/database.service";
import { NotificationType } from "../notification/notification.interface";
import { BookingConfirmationService } from "./booking-confirmation.service";

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

  it("should be defined", () => {
    expect(service).toBeDefined();
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
        status: BookingStatus.PENDING,
        paymentStatus: PaymentStatus.UNPAID,
      });

      vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(mockBooking);
      vi.mocked(databaseService.booking.update).mockResolvedValueOnce({
        ...mockBooking,
        status: BookingStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
      });
      vi.mocked(notificationQueue.add).mockResolvedValueOnce({} as any);

      const result = await service.confirmFromPayment(mockPayment);

      expect(result).toBe(true);
      expect(databaseService.booking.findUnique).toHaveBeenCalledWith({
        where: { id: "booking-123" },
        include: {
          chauffeur: true,
          user: true,
          car: { include: { owner: true } },
          legs: { include: { extensions: true } },
        },
      });
      expect(databaseService.booking.update).toHaveBeenCalledWith({
        where: { id: "booking-123" },
        data: {
          status: BookingStatus.CONFIRMED,
          paymentStatus: PaymentStatus.PAID,
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
        status: BookingStatus.PENDING,
      });

      vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(mockBooking);
      vi.mocked(databaseService.booking.update).mockResolvedValueOnce({
        ...mockBooking,
        status: BookingStatus.CONFIRMED,
      });
      vi.mocked(notificationQueue.add).mockResolvedValueOnce({} as any);

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
      expect(databaseService.booking.findUnique).not.toHaveBeenCalled();
      expect(databaseService.booking.update).not.toHaveBeenCalled();
    });

    it("should return false when booking is not found", async () => {
      const mockPayment = createMockPayment({
        id: "payment-123",
        bookingId: "non-existent-booking",
      });

      vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(null);

      const result = await service.confirmFromPayment(mockPayment);

      expect(result).toBe(false);
      expect(databaseService.booking.update).not.toHaveBeenCalled();
    });

    it("should return false when booking is not in PENDING status", async () => {
      const mockPayment = createMockPayment({
        id: "payment-123",
        bookingId: "booking-123",
      });
      const mockBooking = createMockBookingWithRelations({
        id: "booking-123",
        status: BookingStatus.CONFIRMED, // Already confirmed
      });

      vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(mockBooking);

      const result = await service.confirmFromPayment(mockPayment);

      expect(result).toBe(false);
      expect(databaseService.booking.update).not.toHaveBeenCalled();
    });

    it.each([
      BookingStatus.ACTIVE,
      BookingStatus.COMPLETED,
      BookingStatus.CANCELLED,
      BookingStatus.REJECTED,
    ])(
      "should return false when booking is in %s status (idempotency)",
      async (bookingStatus) => {
        const mockPayment = createMockPayment({
          id: "payment-123",
          bookingId: "booking-123",
        });
        const mockBooking = createMockBookingWithRelations({
          id: "booking-123",
          status: bookingStatus,
        });

        vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(mockBooking);

        const result = await service.confirmFromPayment(mockPayment);

        expect(result).toBe(false);
        expect(databaseService.booking.update).not.toHaveBeenCalled();
      },
    );

    it("should not fail confirmation if notification queueing fails", async () => {
      const mockPayment = createMockPayment({
        id: "payment-123",
        bookingId: "booking-123",
      });
      const mockBooking = createMockBookingWithRelations({
        id: "booking-123",
        status: BookingStatus.PENDING,
      });

      vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(mockBooking);
      vi.mocked(databaseService.booking.update).mockResolvedValueOnce({
        ...mockBooking,
        status: BookingStatus.CONFIRMED,
      });
      vi.mocked(notificationQueue.add).mockRejectedValueOnce(
        new Error("Queue connection failed"),
      );

      // Should not throw, should still return true
      const result = await service.confirmFromPayment(mockPayment);

      expect(result).toBe(true);
      expect(databaseService.booking.update).toHaveBeenCalled();
    });
  });
});
