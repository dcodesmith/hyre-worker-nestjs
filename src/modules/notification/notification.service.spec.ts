import { getQueueToken } from "@nestjs/bullmq";
import { Test, TestingModule } from "@nestjs/testing";
import { BookingStatus } from "@prisma/client";
import { Queue } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NOTIFICATIONS_QUEUE } from "../../config/constants";
import {
  createBooking,
  createCar,
  createChauffeur,
  createOwner,
  createUser,
} from "../../shared/helper.fixtures";
import {
  NotificationChannel,
  NotificationJobData,
  NotificationType,
} from "./notification.interface";
import { NotificationService } from "./notification.service";

describe("NotificationService", () => {
  let service: NotificationService;
  let mockQueue: Partial<Queue<NotificationJobData>>;

  beforeEach(async () => {
    mockQueue = {
      add: vi.fn().mockResolvedValue({ id: "job-123" }),
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
        car: createCar({ owner: createOwner() }),
        chauffeur: createChauffeur(),
        user: createUser(),
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
              email: "john@example.com",
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
      const booking = createBooking({
        car: createCar({ owner: createOwner() }),
        chauffeur: createChauffeur(),
        user: createUser(),
      });
      const bookingLeg = {
        id: "leg-123",
        booking,
        legDate: new Date("2024-01-01"),
        legStartTime: new Date("2024-01-01T08:00:00Z"),
        legEndTime: new Date("2024-01-01T18:00:00Z"),
        extensions: [],
      } as any;

      await service.queueBookingReminderNotifications(bookingLeg, "start");

      expect(mockQueue.add).toHaveBeenCalledTimes(2);
      expect(mockQueue.add).toHaveBeenCalledWith(
        "send-notification",
        expect.objectContaining({
          type: NotificationType.BOOKING_REMINDER_START,
          channels: [NotificationChannel.EMAIL, NotificationChannel.WHATSAPP],
        }),
      );
    });
  });

  it("should have queue injected", () => {
    expect(service).toHaveProperty("notificationQueue");
  });
});
