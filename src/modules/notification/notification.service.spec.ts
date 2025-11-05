import { getQueueToken } from "@nestjs/bull";
import { Test, TestingModule } from "@nestjs/testing";
import { BookingStatus } from "@prisma/client";
import { Queue } from "bull";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBooking } from "../../shared/helper";
import { NotificationService } from "./notification.service";
import {
  NotificationChannel,
  NotificationJobData,
  NotificationType,
} from "./notification.interface";
import { NOTIFICATIONS_QUEUE } from "../../config/constants";

describe("NotificationService", () => {
  let service: NotificationService;
  let mockQueue: Partial<Queue<NotificationJobData>>;

  beforeEach(async () => {
    mockQueue = {
      add: vi.fn().mockResolvedValue({ id: "job-123" }),
      getWaiting: vi.fn().mockResolvedValue([]),
      getActive: vi.fn().mockResolvedValue([]),
      getCompleted: vi.fn().mockResolvedValue([]),
      getFailed: vi.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationService,
        {
          provide: getQueueToken(NOTIFICATIONS_QUEUE),
          useValue: mockQueue,
        },
      ],
    }).compile();

    service = module.get<NotificationService>(NotificationService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("queueBookingStatusNotifications", () => {
    it("should queue status change notification", async () => {
      const booking = createBooking({
        status: BookingStatus.ACTIVE,
      });

      await service.queueBookingStatusNotifications(
        booking,
        BookingStatus.CONFIRMED,
        BookingStatus.ACTIVE,
      );

      expect(mockQueue.add).toHaveBeenCalledWith(
        "send-notification",
        expect.objectContaining({
          type: NotificationType.BOOKING_STATUS_CHANGE,
          channels: [NotificationChannel.EMAIL, NotificationChannel.WHATSAPP],
          bookingId: booking.id,
          recipients: expect.objectContaining({
            customer: expect.objectContaining({
              email: "user@example.com",
              phoneNumber: "1234567890",
            }),
          }),
        }),
        { priority: 1 },
      );
    });
  });

  describe("queueBookingReminderNotifications", () => {
    it("should queue reminder notifications for both customer and chauffeur", async () => {
      const booking = createBooking();
      const bookingLeg = {
        id: "leg-123",
        booking,
        legDate: new Date("2024-01-01"),
        legStartTime: new Date("2024-01-01T08:00:00Z"),
        legEndTime: new Date("2024-01-01T18:00:00Z"),
        extensions: [],
      } as any;

      await service.queueBookingReminderNotifications(bookingLeg, "start");

      expect(mockQueue.add).toHaveBeenCalledTimes(2); // Customer + Chauffeur
      expect(mockQueue.add).toHaveBeenCalledWith(
        "send-notification",
        expect.objectContaining({
          type: NotificationType.BOOKING_REMINDER_START,
          channels: [NotificationChannel.EMAIL, NotificationChannel.WHATSAPP],
        }),
        { priority: 2 },
      );
    });
  });

  it("should have queue injected", () => {
    expect(service).toHaveProperty("notificationQueue");
  });
});
