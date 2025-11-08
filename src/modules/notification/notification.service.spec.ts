import { getQueueToken } from "@nestjs/bullmq";
import { Test, TestingModule } from "@nestjs/testing";
import { BookingStatus } from "@prisma/client";
import { Queue } from "bullmq";
import { normaliseBookingLegDetails } from "src/shared/helper";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NOTIFICATIONS_QUEUE } from "../../config/constants";
import {
  createBooking,
  createBookingLeg,
  createCar,
  createChauffeur,
  createOwner,
  createUser,
} from "../../shared/helper.fixtures";
import {
  CHAUFFEUR_RECIPIENT_TYPE,
  CLIENT_RECIPIENT_TYPE,
  SEND_NOTIFICATION_JOB_NAME,
} from "./notification.const";
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
        SEND_NOTIFICATION_JOB_NAME,
        expect.objectContaining({
          type: NotificationType.BOOKING_STATUS_CHANGE,
          channels: [NotificationChannel.EMAIL, NotificationChannel.WHATSAPP],
          bookingId: booking.id,
          recipients: expect.objectContaining({
            [CLIENT_RECIPIENT_TYPE]: expect.objectContaining({
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
      const bookingLeg = { ...createBookingLeg(), booking };

      await service.queueBookingReminderNotifications(
        normaliseBookingLegDetails(bookingLeg),
        NotificationType.BOOKING_REMINDER_START,
      );

      expect(mockQueue.add).toHaveBeenCalledTimes(2);
      expect(mockQueue.add).toHaveBeenNthCalledWith(
        1,
        SEND_NOTIFICATION_JOB_NAME,
        expect.objectContaining({
          type: NotificationType.BOOKING_REMINDER_START,
          channels: [NotificationChannel.EMAIL, NotificationChannel.WHATSAPP],
          bookingId: booking.id,
          recipients: expect.objectContaining({
            [CLIENT_RECIPIENT_TYPE]: expect.objectContaining({
              email: "john@example.com",
              phoneNumber: "1234567890",
            }),
          }),
          templateData: expect.objectContaining({
            recipientType: CLIENT_RECIPIENT_TYPE,
            subject: "Booking Reminder - Your service starts in approximately 1 hour",
          }),
        }),
        undefined,
      );
      expect(mockQueue.add).toHaveBeenNthCalledWith(
        2,
        SEND_NOTIFICATION_JOB_NAME,
        expect.objectContaining({
          type: NotificationType.BOOKING_REMINDER_START,
          channels: [NotificationChannel.EMAIL, NotificationChannel.WHATSAPP],
          bookingId: booking.id,
          recipients: expect.objectContaining({
            [CHAUFFEUR_RECIPIENT_TYPE]: expect.objectContaining({
              email: "chauffeur@example.com",
              phoneNumber: "0987654321",
            }),
          }),
          templateData: expect.objectContaining({
            recipientType: CHAUFFEUR_RECIPIENT_TYPE,
            subject: "Booking Reminder - You have a service starting in approximately 1 hour",
          }),
        }),
        undefined,
      );
    });
  });

  it("should have queue injected", () => {
    expect(service).toHaveProperty("notificationQueue");
  });
});
