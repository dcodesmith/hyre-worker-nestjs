import { Test, TestingModule } from "@nestjs/testing";
import { BookingStatus, PaymentStatus, Status } from "@prisma/client";
import { addHours } from "date-fns";
import Decimal from "decimal.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import {
  createBooking,
  createBookingLeg,
  createCar,
  createChauffeur,
  createOwner,
  createUser,
} from "../../shared/helper.fixtures";
import { DatabaseService } from "../database/database.service";
import { BookingReminderHandler } from "../notification/handlers/booking-reminder.handler";
import { NotificationType } from "../notification/notification.interface";
import { NotificationOutboxService } from "../notification/notification-outbox.service";
import { PushTokenService } from "../notification/push-token.service";
import { ReminderService } from "./reminder.service";

describe("ReminderService", () => {
  let service: ReminderService;
  let databaseService: DatabaseService;
  let notificationOutboxService: NotificationOutboxService;
  let pushTokenService: PushTokenService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReminderService,
        {
          provide: DatabaseService,
          useValue: {
            bookingLeg: {
              findMany: vi.fn().mockResolvedValue([]),
            },
          },
        },
        {
          provide: NotificationOutboxService,
          useValue: {
            create: vi.fn().mockResolvedValue(1),
          },
        },
        {
          provide: BookingReminderHandler,
          useValue: {
            eventType: "BOOKING_REMINDER",
            buildEvents: vi.fn(),
          },
        },
        {
          provide: PushTokenService,
          useValue: {
            getActiveTokensForUsers: vi.fn().mockResolvedValue({}),
          },
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get<ReminderService>(ReminderService);
    databaseService = module.get<DatabaseService>(DatabaseService);
    notificationOutboxService = module.get<NotificationOutboxService>(NotificationOutboxService);
    pushTokenService = module.get<PushTokenService>(PushTokenService);
  });
  describe("sendBookingStartReminders", () => {
    // Use fake timers for time-sensitive tests to avoid flakiness
    // caused by time drift between test setup and service execution
    afterEach(() => {
      vi.useRealTimers();
    });

    it("should return message when no legs found", async () => {
      vi.mocked(databaseService.bookingLeg.findMany).mockResolvedValueOnce([]);

      const result = await service.sendBookingStartReminders();

      expect(result).toBe("No relevant booking legs today, so no start reminders to send.");
      expect(notificationOutboxService.create).not.toHaveBeenCalled();
    });

    it("should queue notifications for matching legs", async () => {
      // Use a fixed time to avoid flakiness from minute boundary race conditions
      const fixedNow = new Date("2026-01-24T10:30:30.000Z");
      vi.useFakeTimers();
      vi.setSystemTime(fixedNow);

      const legStartTime = addHours(fixedNow, 0.5); // 30 minutes from now
      const booking = createBooking({
        status: BookingStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
        chauffeur: createChauffeur(),
        car: createCar({ status: Status.BOOKED, owner: createOwner() }),
        user: createUser(),
      });
      const leg = {
        ...createBookingLeg({
          legDate: fixedNow,
          legStartTime,
        }),
        booking,
      };

      vi.mocked(databaseService.bookingLeg.findMany).mockResolvedValueOnce([leg]);

      const result = await service.sendBookingStartReminders();

      expect(notificationOutboxService.create).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "BOOKING_REMINDER" }),
        expect.objectContaining({
          bookingLeg: leg,
          type: NotificationType.BOOKING_REMINDER_START,
          context: expect.objectContaining({
            customerPushTokens: expect.any(Array),
            chauffeurPushTokens: expect.any(Array),
          }),
        }),
      );
      expect(result).toContain("Processed and queued start reminders for 1 legs.");
    });

    it("should handle errors when queueing notifications", async () => {
      // Use a fixed time to avoid flakiness
      const fixedNow = new Date("2026-01-24T10:30:30.000Z");
      vi.useFakeTimers();
      vi.setSystemTime(fixedNow);

      const legStartTime = addHours(fixedNow, 0.5);
      const booking = createBooking({
        status: BookingStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
        chauffeur: createChauffeur(),
        car: createCar({ status: Status.BOOKED, owner: createOwner() }),
        user: createUser(),
      });
      const leg = {
        ...createBookingLeg({
          legDate: fixedNow,
          legStartTime,
        }),
        booking,
      };

      vi.mocked(databaseService.bookingLeg.findMany).mockResolvedValueOnce([leg]);
      vi.mocked(notificationOutboxService.create).mockRejectedValueOnce(new Error("Queue error"));

      const result = await service.sendBookingStartReminders();

      expect(result).toContain("Processed and queued start reminders for 0 legs.");
    });

    it("should throw error when database query fails", async () => {
      const error = new Error("Database error");
      vi.mocked(databaseService.bookingLeg.findMany).mockRejectedValueOnce(error);

      await expect(service.sendBookingStartReminders()).rejects.toThrow(error);
    });

    it("prefetches push tokens for all recipients in a single call (Issue 13A)", async () => {
      const fixedNow = new Date("2026-01-24T10:30:30.000Z");
      vi.useFakeTimers();
      vi.setSystemTime(fixedNow);

      const legStartTime = addHours(fixedNow, 0.5);
      const customerA = createUser({ id: "user-customer-a" });
      const customerB = createUser({ id: "user-customer-b" });
      const chauffeurA = createChauffeur({ id: "chauffeur-a" });
      const chauffeurB = createChauffeur({ id: "chauffeur-b" });

      const buildLeg = (
        customer: ReturnType<typeof createUser>,
        chauffeur: ReturnType<typeof createChauffeur>,
      ) => ({
        ...createBookingLeg({ legDate: fixedNow, legStartTime }),
        booking: createBooking({
          status: BookingStatus.CONFIRMED,
          paymentStatus: PaymentStatus.PAID,
          chauffeur,
          chauffeurId: chauffeur.id,
          car: createCar({ status: Status.BOOKED, owner: createOwner() }),
          user: customer,
          userId: customer.id,
        }),
      });

      const legs = [buildLeg(customerA, chauffeurA), buildLeg(customerB, chauffeurB)];
      vi.mocked(databaseService.bookingLeg.findMany).mockResolvedValueOnce(legs);
      vi.mocked(pushTokenService.getActiveTokensForUsers).mockResolvedValueOnce({
        [customerA.id]: ["token-customer-a"],
        [customerB.id]: ["token-customer-b"],
        [chauffeurA.id]: ["token-chauffeur-a"],
        [chauffeurB.id]: ["token-chauffeur-b"],
      });

      await service.sendBookingStartReminders();

      expect(pushTokenService.getActiveTokensForUsers).toHaveBeenCalledTimes(1);
      expect(pushTokenService.getActiveTokensForUsers).toHaveBeenCalledWith(
        expect.arrayContaining([customerA.id, customerB.id, chauffeurA.id, chauffeurB.id]),
      );
      expect(notificationOutboxService.create).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        expect.objectContaining({
          context: {
            customerPushTokens: ["token-customer-a"],
            chauffeurPushTokens: ["token-chauffeur-a"],
          },
        }),
      );
      expect(notificationOutboxService.create).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        expect.objectContaining({
          context: {
            customerPushTokens: ["token-customer-b"],
            chauffeurPushTokens: ["token-chauffeur-b"],
          },
        }),
      );
    });
  });

  describe("sendBookingEndReminders", () => {
    // Use fake timers for time-sensitive tests to avoid flakiness
    // caused by time drift between test setup and service execution
    afterEach(() => {
      vi.useRealTimers();
    });

    it("should return message when no legs found", async () => {
      vi.mocked(databaseService.bookingLeg.findMany).mockResolvedValueOnce([]);

      const result = await service.sendBookingEndReminders();

      expect(result).toBe("No relevant booking legs today, so no end reminders to send.");
      expect(notificationOutboxService.create).not.toHaveBeenCalled();
    });

    it("should queue notifications for legs with effective end time in reminder window", async () => {
      // Use a fixed time to avoid flakiness from minute boundary race conditions
      const fixedNow = new Date("2026-01-24T10:30:30.000Z");
      vi.useFakeTimers();
      vi.setSystemTime(fixedNow);

      const reminderTargetTime = addHours(fixedNow, 1);
      const booking = createBooking({
        status: BookingStatus.ACTIVE,
        paymentStatus: PaymentStatus.PAID,
        endDate: reminderTargetTime,
        car: createCar({ status: Status.BOOKED, owner: createOwner() }),
        user: createUser(),
      });
      const leg = {
        ...createBookingLeg({
          legDate: fixedNow,
        }),
        booking,
        extensions: [],
      };

      vi.mocked(databaseService.bookingLeg.findMany).mockResolvedValueOnce([leg]);

      const result = await service.sendBookingEndReminders();

      expect(notificationOutboxService.create).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "BOOKING_REMINDER" }),
        expect.objectContaining({
          bookingLeg: leg,
          type: NotificationType.BOOKING_REMINDER_END,
          context: expect.objectContaining({
            customerPushTokens: expect.any(Array),
            chauffeurPushTokens: expect.any(Array),
          }),
        }),
      );
      expect(result).toContain("Processed and queued end reminders for 1 legs.");
    });

    it("should skip legs with effective end time outside reminder window", async () => {
      // Use a fixed time to avoid flakiness
      const fixedNow = new Date("2026-01-24T10:30:30.000Z");
      vi.useFakeTimers();
      vi.setSystemTime(fixedNow);

      const booking = createBooking({
        status: BookingStatus.ACTIVE,
        paymentStatus: PaymentStatus.PAID,
        endDate: addHours(fixedNow, 2), // 2 hours from now, outside window
        car: createCar({ status: Status.BOOKED, owner: createOwner() }),
        user: createUser(),
      });
      const leg = {
        ...createBookingLeg({
          legDate: fixedNow,
        }),
        booking,
        extensions: [],
      };

      vi.mocked(databaseService.bookingLeg.findMany).mockResolvedValueOnce([leg]);

      const result = await service.sendBookingEndReminders();

      expect(notificationOutboxService.create).not.toHaveBeenCalled();
      expect(result).toContain("Processed and queued end reminders for 0 legs.");
    });

    it("should use extension end time when available", async () => {
      // Use a fixed time to avoid flakiness
      const fixedNow = new Date("2026-01-24T10:30:30.000Z");
      vi.useFakeTimers();
      vi.setSystemTime(fixedNow);

      const reminderTargetTime = addHours(fixedNow, 1);
      const extensionEndTime = reminderTargetTime;
      const booking = createBooking({
        status: BookingStatus.ACTIVE,
        paymentStatus: PaymentStatus.PAID,
        endDate: addHours(fixedNow, 2),
        car: createCar({ status: Status.BOOKED, owner: createOwner() }),
        user: createUser(),
      });
      const leg = {
        ...createBookingLeg({
          legDate: fixedNow,
        }),
        booking,
        extensions: [
          {
            id: "ext-1",
            extensionEndTime,
            paymentStatus: PaymentStatus.PAID,
            status: "ACTIVE",
            extensionStartTime: fixedNow,
            totalAmount: new Decimal(5000),
            paymentId: "pay-ext-1",
            paymentIntent: "pi-ext-1",
            fleetOwnerPayoutAmountNet: new Decimal(4500),
            netTotal: new Decimal(4500),
            overallPayoutStatus: null,
            platformCustomerServiceFeeAmount: new Decimal(0),
            platformFleetOwnerCommissionAmount: new Decimal(500),
            platformFleetOwnerCommissionRatePercent: new Decimal(10),
            extendedDurationHours: 1,
            eventType: "HOURLY_ADDITION",
            bookingLegId: "leg-1",
            createdAt: fixedNow,
            updatedAt: fixedNow,
          },
        ],
      };

      vi.mocked(databaseService.bookingLeg.findMany).mockResolvedValueOnce([leg]);

      const result = await service.sendBookingEndReminders();

      expect(notificationOutboxService.create).toHaveBeenCalled();
      expect(result).toContain("Processed and queued end reminders for 1 legs.");
    });

    it("should throw error when database query fails", async () => {
      const error = new Error("Database error");
      vi.mocked(databaseService.bookingLeg.findMany).mockRejectedValueOnce(error);

      await expect(service.sendBookingEndReminders()).rejects.toThrow(error);
    });
  });
});
