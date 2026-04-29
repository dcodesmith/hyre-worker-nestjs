import { getQueueToken } from "@nestjs/bullmq";
import { Test, TestingModule } from "@nestjs/testing";
import { BookingStatus } from "@prisma/client";
import { Queue } from "bullmq";
import { normaliseBookingLegDetails } from "src/shared/helper";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
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
import {
  BOOKING_REMINDER_TEMPLATE_KIND,
  BOOKING_STATUS_TEMPLATE_KIND,
} from "./template-data.interface";

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
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get<NotificationService>(NotificationService);
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
          templateData: expect.objectContaining({
            templateKind: BOOKING_STATUS_TEMPLATE_KIND,
          }),
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

    it("should queue WhatsApp-only status notification for WhatsApp-agent guest", async () => {
      const booking = createBooking({
        status: BookingStatus.ACTIVE,
        car: createCar({ owner: createOwner() }),
        chauffeur: createChauffeur(),
        user: null,
        guestUser: {
          name: "WhatsApp Guest",
          email: "whatsapp.2348012345678@tripdly.com",
          phoneNumber: "+2348012345678",
          guestContactSource: "WHATSAPP_AGENT",
          preferredNotificationChannel: "WHATSAPP_ONLY",
        },
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
          channels: [NotificationChannel.WHATSAPP],
          bookingId: booking.id,
          recipients: expect.objectContaining({
            [CLIENT_RECIPIENT_TYPE]: expect.objectContaining({
              email: undefined,
              phoneNumber: "+2348012345678",
            }),
          }),
        }),
        { priority: 1 },
      );
    });

    it("should queue email-only status notification when guest prefers email", async () => {
      const booking = createBooking({
        status: BookingStatus.ACTIVE,
        car: createCar({ owner: createOwner() }),
        chauffeur: createChauffeur(),
        user: null,
        guestUser: {
          name: "Email Guest",
          email: "guest@example.com",
          phoneNumber: "+2348012345678",
          guestContactSource: "WEB_GUEST_FORM",
          preferredNotificationChannel: "EMAIL_ONLY",
        },
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
          channels: [NotificationChannel.EMAIL],
          bookingId: booking.id,
          recipients: expect.objectContaining({
            [CLIENT_RECIPIENT_TYPE]: expect.objectContaining({
              email: "guest@example.com",
              phoneNumber: undefined,
            }),
          }),
        }),
        { priority: 1 },
      );
    });

    it("should skip status notification when customer has no deliverable channels", async () => {
      const booking = createBooking({
        status: BookingStatus.ACTIVE,
        car: createCar({ owner: createOwner() }),
        chauffeur: createChauffeur(),
        user: null,
        guestUser: {
          name: "No Contact Guest",
          email: null,
          phoneNumber: null,
          guestContactSource: "WEB_GUEST_FORM",
          preferredNotificationChannel: "EMAIL_AND_WHATSAPP",
        },
      });

      await service.queueBookingStatusNotifications(
        booking,
        BookingStatus.CONFIRMED,
        BookingStatus.ACTIVE,
      );

      expect(mockQueue.add).not.toHaveBeenCalled();
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
            templateKind: BOOKING_REMINDER_TEMPLATE_KIND,
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
            templateKind: BOOKING_REMINDER_TEMPLATE_KIND,
            recipientType: CHAUFFEUR_RECIPIENT_TYPE,
            subject: "Booking Reminder - You have a service starting in approximately 1 hour",
          }),
        }),
        undefined,
      );
    });
  });
});
