import { getQueueToken } from "@nestjs/bullmq";
import { EventEmitter2, EventEmitterReadinessWatcher } from "@nestjs/event-emitter";
import { Test, TestingModule } from "@nestjs/testing";
import type { Payment } from "@prisma/client";
import {
  BookingReferralStatus,
  BookingStatus,
  PaymentAttemptStatus,
  PaymentStatus,
  Status,
} from "@prisma/client";
import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { CREATE_FLIGHT_ALERT_JOB, FLIGHT_ALERTS_QUEUE } from "../../config/constants";
import { BOOKING_CONFIRMED_EVENT } from "../../shared/events/airport-activation.events";
import { createBooking, createCar, createUser } from "../../shared/helper.fixtures";
import type { BookingWithRelations } from "../../types";
import { DatabaseService } from "../database/database.service";
import { BookingConfirmedHandler } from "../notification/handlers/booking-confirmed.handler";
import { NotificationOutboxService } from "../notification/notification-outbox.service";
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

type FlightAlertRecord = {
  id: string;
  flightNumber: string;
  scheduledDeparture: Date | null;
  originCode: string;
  originTimezone: string | null;
  destinationCodeIATA: string | null;
};

describe("BookingConfirmationService", () => {
  let service: BookingConfirmationService;
  let databaseService: DatabaseService;
  let notificationOutboxService: NotificationOutboxService;
  let bookingConfirmedHandler: BookingConfirmedHandler;
  let eventEmitter: EventEmitter2;
  let eventEmitterReadinessWatcher: EventEmitterReadinessWatcher;
  let flightAlertQueue: { add: ReturnType<typeof vi.fn> };
  let findFlightForAlert: ReturnType<
    typeof vi.fn<(args: unknown) => Promise<FlightAlertRecord | null>>
  >;

  beforeEach(async () => {
    findFlightForAlert = vi.fn();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingConfirmationService,
        {
          provide: DatabaseService,
          useValue: {
            $transaction: vi.fn(async (callback) => callback(databaseService)),
            booking: {
              findUnique: vi.fn(),
              update: vi.fn(),
              updateMany: vi.fn(),
            },
            user: {
              update: vi.fn(),
            },
            car: {
              update: vi.fn(),
            },
            flight: {
              findUnique: findFlightForAlert,
            },
          },
        },
        {
          provide: NotificationOutboxService,
          useValue: {
            create: vi.fn().mockResolvedValue(2),
          },
        },
        { provide: BookingConfirmedHandler, useValue: {} },
        {
          provide: getQueueToken(FLIGHT_ALERTS_QUEUE),
          useValue: { add: vi.fn() },
        },
        {
          provide: EventEmitter2,
          useValue: {
            emit: vi.fn(),
          },
        },
        {
          provide: EventEmitterReadinessWatcher,
          useValue: {
            waitUntilReady: vi.fn().mockResolvedValue(undefined),
          },
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get<BookingConfirmationService>(BookingConfirmationService);
    databaseService = module.get<DatabaseService>(DatabaseService);
    notificationOutboxService = module.get(NotificationOutboxService);
    bookingConfirmedHandler = module.get(BookingConfirmedHandler);
    eventEmitter = module.get<EventEmitter2>(EventEmitter2);
    eventEmitterReadinessWatcher = module.get<EventEmitterReadinessWatcher>(
      EventEmitterReadinessWatcher,
    );
    flightAlertQueue = module.get(getQueueToken(FLIGHT_ALERTS_QUEUE));
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
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it("should write booking confirmation notifications to the outbox transaction", async () => {
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

      await service.confirmFromPayment(mockPayment);

      expect(notificationOutboxService.create).toHaveBeenCalledWith(
        bookingConfirmedHandler,
        { booking: mockBooking },
        databaseService,
      );
    });

    it("should mark reserved referral discount as used after successful payment", async () => {
      const mockPayment = createMockPayment({
        id: "payment-123",
        bookingId: "booking-123",
      });
      const mockBooking = createMockBookingWithRelations({
        id: "booking-123",
        userId: "user-123",
        referralReferrerUserId: "referrer-123",
        referralStatus: BookingReferralStatus.RESERVED,
        status: BookingStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
      });

      vi.mocked(databaseService.booking.updateMany).mockResolvedValueOnce({ count: 1 });
      vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(mockBooking);
      vi.mocked(databaseService.booking.update).mockResolvedValueOnce({
        ...mockBooking,
        referralStatus: BookingReferralStatus.APPLIED,
      });
      vi.mocked(databaseService.user.update).mockResolvedValueOnce(
        createUser({ id: "user-123", referralDiscountUsed: true }),
      );
      vi.mocked(databaseService.car.update).mockResolvedValueOnce(mockBooking.car);

      const result = await service.confirmFromPayment(mockPayment);

      expect(result).toBe(true);
      expect(databaseService.user.update).toHaveBeenCalledWith({
        where: { id: "user-123" },
        data: { referralDiscountUsed: true },
      });
      expect(databaseService.booking.update).toHaveBeenCalledWith({
        where: { id: "booking-123" },
        data: { referralStatus: BookingReferralStatus.APPLIED },
      });
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

    it("should propagate outbox failures so the booking transaction can roll back", async () => {
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
      vi.mocked(notificationOutboxService.create).mockRejectedValueOnce(
        new Error("Outbox write failed"),
      );

      await expect(service.confirmFromPayment(mockPayment)).rejects.toThrow("Outbox write failed");
      expect(databaseService.car.update).not.toHaveBeenCalled();
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

      // Should not throw, should still return true
      const result = await service.confirmFromPayment(mockPayment);

      expect(result).toBe(true);
      expect(notificationOutboxService.create).toHaveBeenCalled();
    });

    it("should emit booking confirmed event for airport pickup bookings", async () => {
      const mockPayment = createMockPayment({
        id: "payment-airport-1",
        bookingId: "booking-airport-1",
      });
      const activationAt = new Date(Date.now() + 10 * 60 * 1000);
      const laterActivationAt = new Date(activationAt.getTime() + 30 * 60 * 1000);
      const mockBooking = createMockBookingWithRelations({
        id: "booking-airport-1",
        type: "AIRPORT_PICKUP",
        flightId: "flight-1",
        status: BookingStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
        legs: [
          {
            id: "leg-1",
            bookingId: "booking-airport-1",
            legDate: laterActivationAt,
            legStartTime: laterActivationAt,
            legEndTime: new Date(laterActivationAt.getTime() + 60 * 60 * 1000),
            totalDailyPrice: new Decimal(1000),
            itemsNetValueForLeg: new Decimal(1000),
            platformCommissionRateOnLeg: new Decimal(0),
            platformCommissionAmountOnLeg: new Decimal(0),
            fleetOwnerEarningForLeg: new Decimal(1000),
            notes: "",
            createdAt: new Date(),
            updatedAt: new Date(),
            extensions: [],
          },
          {
            id: "leg-2",
            bookingId: "booking-airport-1",
            legDate: activationAt,
            legStartTime: activationAt,
            legEndTime: new Date(activationAt.getTime() + 60 * 60 * 1000),
            totalDailyPrice: new Decimal(1000),
            itemsNetValueForLeg: new Decimal(1000),
            platformCommissionRateOnLeg: new Decimal(0),
            platformCommissionAmountOnLeg: new Decimal(0),
            fleetOwnerEarningForLeg: new Decimal(1000),
            notes: "",
            createdAt: new Date(),
            updatedAt: new Date(),
            extensions: [],
          },
        ],
      });

      vi.mocked(databaseService.booking.updateMany).mockResolvedValueOnce({ count: 1 });
      vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(mockBooking);
      vi.mocked(databaseService.car.update).mockResolvedValueOnce(mockBooking.car);
      findFlightForAlert.mockResolvedValueOnce({
        id: "flight-1",
        flightNumber: "BA74",
        scheduledDeparture: new Date("2030-01-01T08:00:00.000Z"),
        originCode: "EGLL",
        originTimezone: "Europe/London",
        destinationCodeIATA: "LOS",
      });

      await service.confirmFromPayment(mockPayment);

      expect(eventEmitter.emit).toHaveBeenCalledWith(BOOKING_CONFIRMED_EVENT, {
        bookingId: "booking-airport-1",
        bookingType: "AIRPORT_PICKUP",
        activationAt: activationAt.toISOString(),
      });
      expect(flightAlertQueue.add).toHaveBeenCalledWith(
        CREATE_FLIGHT_ALERT_JOB,
        {
          flightId: "flight-1",
          flightNumber: "BA74",
          departureTime: "2030-01-01T08:00:00.000Z",
          originCode: "EGLL",
          originTimezone: "Europe/London",
          destinationIATA: "LOS",
        },
        { jobId: "flight-alert-flight-1" },
      );
    });

    it("should not fail confirmation if booking confirmed event emission fails", async () => {
      const mockPayment = createMockPayment({
        id: "payment-airport-event-failure",
        bookingId: "booking-airport-event-failure",
      });
      const activationAt = new Date(Date.now() + 10 * 60 * 1000);
      const mockBooking = createMockBookingWithRelations({
        id: "booking-airport-event-failure",
        type: "AIRPORT_PICKUP",
        status: BookingStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
        legs: [
          {
            id: "leg-event-failure",
            bookingId: "booking-airport-event-failure",
            legDate: activationAt,
            legStartTime: activationAt,
            legEndTime: new Date(activationAt.getTime() + 60 * 60 * 1000),
            totalDailyPrice: new Decimal(1000),
            itemsNetValueForLeg: new Decimal(1000),
            platformCommissionRateOnLeg: new Decimal(0),
            platformCommissionAmountOnLeg: new Decimal(0),
            fleetOwnerEarningForLeg: new Decimal(1000),
            notes: "",
            createdAt: new Date(),
            updatedAt: new Date(),
            extensions: [],
          },
        ],
      });

      vi.mocked(databaseService.booking.updateMany).mockResolvedValueOnce({ count: 1 });
      vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(mockBooking);
      vi.mocked(databaseService.car.update).mockResolvedValueOnce(mockBooking.car);
      vi.mocked(eventEmitterReadinessWatcher.waitUntilReady).mockRejectedValueOnce(
        new Error("Event emitter not ready"),
      );

      const result = await service.confirmFromPayment(mockPayment);

      expect(result).toBe(true);
      expect(eventEmitter.emit).not.toHaveBeenCalledWith(
        BOOKING_CONFIRMED_EVENT,
        expect.any(Object),
      );
    });

    it("should skip booking confirmed event for airport pickup bookings without leg start time", async () => {
      const mockPayment = createMockPayment({
        id: "payment-airport-2",
        bookingId: "booking-airport-2",
      });
      const legDate = new Date(Date.now() + 10 * 60 * 1000);
      const mockBooking = createMockBookingWithRelations({
        id: "booking-airport-2",
        type: "AIRPORT_PICKUP",
        status: BookingStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
        legs: [
          {
            id: "leg-1",
            bookingId: "booking-airport-2",
            legDate,
            legStartTime: null,
            legEndTime: new Date(legDate.getTime() + 60 * 60 * 1000),
            totalDailyPrice: new Decimal(1000),
            itemsNetValueForLeg: new Decimal(1000),
            platformCommissionRateOnLeg: new Decimal(0),
            platformCommissionAmountOnLeg: new Decimal(0),
            fleetOwnerEarningForLeg: new Decimal(1000),
            notes: "",
            createdAt: new Date(),
            updatedAt: new Date(),
            extensions: [],
          },
        ],
      });

      vi.mocked(databaseService.booking.updateMany).mockResolvedValueOnce({ count: 1 });
      vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(mockBooking);
      vi.mocked(databaseService.car.update).mockResolvedValueOnce(mockBooking.car);

      await service.confirmFromPayment(mockPayment);

      expect(eventEmitter.emit).not.toHaveBeenCalledWith(
        BOOKING_CONFIRMED_EVENT,
        expect.any(Object),
      );
    });
  });
});
