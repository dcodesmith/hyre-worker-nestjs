import { Test, TestingModule } from "@nestjs/testing";
import { BookingStatus, PaymentStatus, Status } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { addHours } from "date-fns";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normaliseBookingLegDetails } from "../../shared/helper";
import {
  createBooking,
  createBookingLeg,
  createCar,
  createChauffeur,
  createOwner,
  createUser,
} from "../../shared/helper.fixtures";
import { DatabaseService } from "../database/database.service";
import { NotificationType } from "../notification/notification.interface";
import { NotificationService } from "../notification/notification.service";
import { ReminderService } from "./reminder.service";

describe("ReminderService", () => {
  let service: ReminderService;
  let databaseService: DatabaseService;
  let notificationService: NotificationService;

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
          provide: NotificationService,
          useValue: {
            queueBookingReminderNotifications: vi.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get<ReminderService>(ReminderService);
    databaseService = module.get<DatabaseService>(DatabaseService);
    notificationService = module.get<NotificationService>(NotificationService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  it("should have all required services injected", () => {
    expect(databaseService).toBeDefined();
    expect(notificationService).toBeDefined();
  });

  describe("sendBookingStartReminderEmails", () => {
    it("should return message when no legs found", async () => {
      vi.mocked(databaseService.bookingLeg.findMany).mockResolvedValueOnce([]);

      const result = await service.sendBookingStartReminderEmails();

      expect(result).toBe("No relevant booking legs today, so no start reminders to send.");
      expect(notificationService.queueBookingReminderNotifications).not.toHaveBeenCalled();
    });

    it("should queue notifications for matching legs", async () => {
      const now = new Date();
      const legStartTime = addHours(now, 0.5); // 30 minutes from now
      const booking = createBooking({
        status: BookingStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
        chauffeur: createChauffeur(),
        car: createCar({ status: Status.BOOKED, owner: createOwner() }),
        user: createUser(),
      });
      const leg = {
        ...createBookingLeg({
          legDate: now,
          legStartTime,
        }),
        booking,
      };

      vi.mocked(databaseService.bookingLeg.findMany).mockResolvedValueOnce([leg]);

      const result = await service.sendBookingStartReminderEmails();

      expect(notificationService.queueBookingReminderNotifications).toHaveBeenCalledWith(
        normaliseBookingLegDetails(leg),
        NotificationType.BOOKING_REMINDER_START,
      );
      expect(result).toContain("Processed and queued start reminders for 1 legs.");
    });

    it("should handle errors when queueing notifications", async () => {
      const now = new Date();
      const legStartTime = addHours(now, 0.5);
      const booking = createBooking({
        status: BookingStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
        chauffeur: createChauffeur(),
        car: createCar({ status: Status.BOOKED, owner: createOwner() }),
        user: createUser(),
      });
      const leg = {
        ...createBookingLeg({
          legDate: now,
          legStartTime,
        }),
        booking,
      };

      vi.mocked(databaseService.bookingLeg.findMany).mockResolvedValueOnce([leg]);
      vi.mocked(notificationService.queueBookingReminderNotifications).mockRejectedValueOnce(
        new Error("Queue error"),
      );

      const result = await service.sendBookingStartReminderEmails();

      expect(result).toContain("Processed and queued start reminders for 0 legs.");
    });

    it("should throw error when database query fails", async () => {
      const error = new Error("Database error");
      vi.mocked(databaseService.bookingLeg.findMany).mockRejectedValueOnce(error);

      await expect(service.sendBookingStartReminderEmails()).rejects.toThrow(error);
    });
  });

  describe("sendBookingEndReminderEmails", () => {
    // Use fake timers for time-sensitive tests to avoid flakiness
    // caused by time drift between test setup and service execution
    afterEach(() => {
      vi.useRealTimers();
    });

    it("should return message when no legs found", async () => {
      vi.mocked(databaseService.bookingLeg.findMany).mockResolvedValueOnce([]);

      const result = await service.sendBookingEndReminderEmails();

      expect(result).toBe("No relevant booking legs today, so no end reminders to send.");
      expect(notificationService.queueBookingReminderNotifications).not.toHaveBeenCalled();
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

      const result = await service.sendBookingEndReminderEmails();

      expect(notificationService.queueBookingReminderNotifications).toHaveBeenCalledWith(
        normaliseBookingLegDetails(leg),
        NotificationType.BOOKING_REMINDER_END,
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

      const result = await service.sendBookingEndReminderEmails();

      expect(notificationService.queueBookingReminderNotifications).not.toHaveBeenCalled();
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

      const result = await service.sendBookingEndReminderEmails();

      expect(notificationService.queueBookingReminderNotifications).toHaveBeenCalled();
      expect(result).toContain("Processed and queued end reminders for 1 legs.");
    });

    it("should throw error when database query fails", async () => {
      const error = new Error("Database error");
      vi.mocked(databaseService.bookingLeg.findMany).mockRejectedValueOnce(error);

      await expect(service.sendBookingEndReminderEmails()).rejects.toThrow(error);
    });
  });
});
