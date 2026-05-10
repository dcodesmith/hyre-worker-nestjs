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
  FLEET_OWNER_RECIPIENT_TYPE,
} from "./notification.const";
import {
  NotificationChannel,
  NotificationJobData,
  NotificationType,
} from "./notification.interface";
import { NotificationService } from "./notification.service";
import { RecipientChannelResolverService } from "./recipient-channel-resolver.service";
import {
  BOOKING_REMINDER_TEMPLATE_KIND,
  BOOKING_STATUS_TEMPLATE_KIND,
} from "./template-data.interface";

describe("NotificationService", () => {
  let service: NotificationService;
  let mockQueue: Partial<Queue<NotificationJobData>>;
  const pushTokensByUserId = new Map<string, string[]>();
  const recipientChannelResolverMock = {
    resolve: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    pushTokensByUserId.clear();
    recipientChannelResolverMock.resolve.mockImplementation(
      async (input: {
        email?: string;
        phoneNumber?: string;
        userId?: string;
        pushTokens?: string[];
      }) => {
        const channels: NotificationChannel[] = [];
        if (input.email) {
          channels.push(NotificationChannel.EMAIL);
        }
        if (input.phoneNumber) {
          channels.push(NotificationChannel.WHATSAPP);
        }
        const resolvedPushTokens =
          input.pushTokens ?? (input.userId ? (pushTokensByUserId.get(input.userId) ?? []) : []);
        if (resolvedPushTokens.length > 0) {
          channels.push(NotificationChannel.PUSH);
        }
        return {
          channels,
          pushTokens: resolvedPushTokens,
        };
      },
    );

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
        {
          provide: RecipientChannelResolverService,
          useValue: recipientChannelResolverMock,
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get<NotificationService>(NotificationService);
  });
  describe("buildBookingStatusChangeJobData", () => {
    it("returns email + whatsapp channels for a registered user", async () => {
      const booking = createBooking({
        status: BookingStatus.ACTIVE,
        car: createCar({ owner: createOwner() }),
        chauffeur: createChauffeur(),
        user: createUser(),
      });

      const jobData = await service.buildBookingStatusChangeJobData({
        booking,
        oldStatus: BookingStatus.CONFIRMED,
        newStatus: BookingStatus.ACTIVE,
      });

      expect(jobData).toMatchObject({
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
      });
    });

    it("returns whatsapp-only for a WhatsApp-agent guest", async () => {
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

      const jobData = await service.buildBookingStatusChangeJobData({
        booking,
        oldStatus: BookingStatus.CONFIRMED,
        newStatus: BookingStatus.ACTIVE,
      });

      expect(jobData).toMatchObject({
        channels: [NotificationChannel.WHATSAPP],
        recipients: expect.objectContaining({
          [CLIENT_RECIPIENT_TYPE]: expect.objectContaining({
            email: undefined,
            phoneNumber: "+2348012345678",
          }),
        }),
      });
    });

    it("returns email-only when the guest prefers email", async () => {
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

      const jobData = await service.buildBookingStatusChangeJobData({
        booking,
        oldStatus: BookingStatus.CONFIRMED,
        newStatus: BookingStatus.ACTIVE,
      });

      expect(jobData).toMatchObject({
        channels: [NotificationChannel.EMAIL],
        recipients: expect.objectContaining({
          [CLIENT_RECIPIENT_TYPE]: expect.objectContaining({
            email: "guest@example.com",
            phoneNumber: undefined,
          }),
        }),
      });
    });

    it("returns null when the customer has no deliverable channels", async () => {
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

      const jobData = await service.buildBookingStatusChangeJobData({
        booking,
        oldStatus: BookingStatus.CONFIRMED,
        newStatus: BookingStatus.ACTIVE,
      });

      expect(jobData).toBeNull();
    });

    it("includes PUSH when the user has active tokens", async () => {
      const booking = createBooking({
        status: BookingStatus.ACTIVE,
        car: createCar({ owner: createOwner() }),
        chauffeur: createChauffeur(),
        user: createUser({ id: "status-user-1" }),
        userId: "status-user-1",
      });
      pushTokensByUserId.set("status-user-1", ["ExponentPushToken[status]"]);

      const jobData = await service.buildBookingStatusChangeJobData({
        booking,
        oldStatus: BookingStatus.CONFIRMED,
        newStatus: BookingStatus.ACTIVE,
      });

      expect(jobData).toMatchObject({
        channels: [
          NotificationChannel.EMAIL,
          NotificationChannel.WHATSAPP,
          NotificationChannel.PUSH,
        ],
        recipients: expect.objectContaining({
          [CLIENT_RECIPIENT_TYPE]: expect.objectContaining({
            pushTokens: ["ExponentPushToken[status]"],
          }),
        }),
      });
    });
  });

  describe("buildBookingReminderJobData", () => {
    it("builds one job per recipient (customer + chauffeur)", async () => {
      const booking = createBooking({
        car: createCar({ owner: createOwner() }),
        chauffeur: createChauffeur(),
        user: createUser(),
      });
      const bookingLeg = { ...createBookingLeg(), booking };

      const jobs = await service.buildBookingReminderJobData(
        normaliseBookingLegDetails(bookingLeg),
        NotificationType.BOOKING_REMINDER_START,
        {
          customerUserId: "client-11",
          chauffeurUserId: "chauffeur-22",
        },
      );

      expect(jobs).toHaveLength(2);
      expect(jobs[0]).toMatchObject({
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
      });
      expect(jobs[1]).toMatchObject({
        type: NotificationType.BOOKING_REMINDER_START,
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
      });
    });

    it("includes PUSH channel when both recipients have active tokens", async () => {
      const booking = createBooking({
        car: createCar({ owner: createOwner() }),
        chauffeur: createChauffeur({ id: "chauffeur-22" }),
        chauffeurId: "chauffeur-22",
        user: createUser({ id: "client-11" }),
        userId: "client-11",
      });
      pushTokensByUserId.set("client-11", ["ExponentPushToken[client]"]);
      pushTokensByUserId.set("chauffeur-22", ["ExponentPushToken[chauffeur]"]);
      const bookingLeg = { ...createBookingLeg(), booking };

      const jobs = await service.buildBookingReminderJobData(
        normaliseBookingLegDetails(bookingLeg),
        NotificationType.BOOKING_REMINDER_START,
        {
          customerUserId: "client-11",
          chauffeurUserId: "chauffeur-22",
        },
      );

      expect(jobs[0]).toMatchObject({
        channels: [
          NotificationChannel.EMAIL,
          NotificationChannel.WHATSAPP,
          NotificationChannel.PUSH,
        ],
        recipients: expect.objectContaining({
          [CLIENT_RECIPIENT_TYPE]: expect.objectContaining({
            pushTokens: ["ExponentPushToken[client]"],
          }),
        }),
      });
      expect(jobs[1]).toMatchObject({
        channels: [
          NotificationChannel.EMAIL,
          NotificationChannel.WHATSAPP,
          NotificationChannel.PUSH,
        ],
        recipients: expect.objectContaining({
          [CHAUFFEUR_RECIPIENT_TYPE]: expect.objectContaining({
            pushTokens: ["ExponentPushToken[chauffeur]"],
          }),
        }),
      });
    });
  });

  describe("buildChauffeurAssignedJobData", () => {
    it("builds the chauffeur-assigned job for the customer", async () => {
      const booking = createBooking({
        status: BookingStatus.CONFIRMED,
        car: createCar({ owner: createOwner() }),
        chauffeur: createChauffeur(),
        user: createUser(),
      });

      const jobData = await service.buildChauffeurAssignedJobData(booking);

      expect(jobData).toMatchObject({
        type: NotificationType.CHAUFFEUR_ASSIGNED,
        channels: [NotificationChannel.EMAIL, NotificationChannel.WHATSAPP],
        bookingId: booking.id,
        recipients: expect.objectContaining({
          [CLIENT_RECIPIENT_TYPE]: expect.objectContaining({
            email: "john@example.com",
            phoneNumber: "1234567890",
          }),
        }),
        templateData: expect.objectContaining({
          templateKind: BOOKING_STATUS_TEMPLATE_KIND,
          title: "been assigned a chauffeur",
          status: "chauffeur assigned",
          subject: "Your chauffeur has been assigned",
        }),
      });
    });

    it("includes PUSH channel when active push tokens exist", async () => {
      const booking = createBooking({
        status: BookingStatus.CONFIRMED,
        car: createCar({ owner: createOwner() }),
        chauffeur: createChauffeur(),
        user: createUser(),
      });
      pushTokensByUserId.set(booking.userId ?? "", ["ExponentPushToken[abc123]"]);

      const jobData = await service.buildChauffeurAssignedJobData(booking);

      expect(jobData).toMatchObject({
        type: NotificationType.CHAUFFEUR_ASSIGNED,
        channels: [
          NotificationChannel.EMAIL,
          NotificationChannel.WHATSAPP,
          NotificationChannel.PUSH,
        ],
        recipients: expect.objectContaining({
          [CLIENT_RECIPIENT_TYPE]: expect.objectContaining({
            pushTokens: ["ExponentPushToken[abc123]"],
          }),
        }),
        pushPayload: expect.objectContaining({
          title: "Your chauffeur has been assigned",
        }),
      });
    });

    it("returns null when the customer has no deliverable channels", async () => {
      const booking = createBooking({
        status: BookingStatus.CONFIRMED,
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

      const jobData = await service.buildChauffeurAssignedJobData(booking);

      expect(jobData).toBeNull();
    });
  });

  describe("buildBookingCancellationJobData", () => {
    it("builds customer + owner jobs when both recipients have channels", async () => {
      const booking = createBooking({
        status: BookingStatus.CONFIRMED,
        car: createCar({ owner: createOwner() }),
        chauffeur: createChauffeur(),
        user: createUser(),
      });

      const { customer, owner } = await service.buildBookingCancellationJobData(booking);

      expect(customer).toMatchObject({
        type: NotificationType.BOOKING_CANCELLED,
        channels: [NotificationChannel.EMAIL, NotificationChannel.WHATSAPP],
        bookingId: booking.id,
        templateData: expect.objectContaining({
          subject: "Your booking has been cancelled",
        }),
      });
      expect(owner).toMatchObject({
        type: NotificationType.BOOKING_CANCELLED,
        channels: [NotificationChannel.EMAIL, NotificationChannel.WHATSAPP],
        bookingId: booking.id,
        templateData: expect.objectContaining({
          subject: "A booking for your vehicle has been cancelled",
        }),
      });
    });

    it("returns null customer when the customer has no channels", async () => {
      const booking = createBooking({
        status: BookingStatus.CONFIRMED,
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

      const { customer, owner } = await service.buildBookingCancellationJobData(booking);

      expect(customer).toBeNull();
      expect(owner).not.toBeNull();
    });

    it("returns null owner when the fleet owner has no email, phone, or push tokens", async () => {
      const booking = createBooking({
        status: BookingStatus.CONFIRMED,
        car: createCar({ owner: createOwner({ email: null, phoneNumber: null }) }),
        chauffeur: createChauffeur(),
        user: createUser(),
      });

      const { customer, owner } = await service.buildBookingCancellationJobData(booking);

      expect(customer).not.toBeNull();
      expect(owner).toBeNull();
    });

    it("includes PUSH channel for the customer when they have active push tokens", async () => {
      const booking = createBooking({
        status: BookingStatus.CONFIRMED,
        car: createCar({ owner: createOwner() }),
        chauffeur: createChauffeur(),
        user: createUser({ id: "cancel-user-1" }),
        userId: "cancel-user-1",
      });
      pushTokensByUserId.set("cancel-user-1", ["ExponentPushToken[cancel-cust]"]);

      const { customer } = await service.buildBookingCancellationJobData(booking);

      expect(customer).toMatchObject({
        type: NotificationType.BOOKING_CANCELLED,
        channels: [
          NotificationChannel.EMAIL,
          NotificationChannel.WHATSAPP,
          NotificationChannel.PUSH,
        ],
        recipients: expect.objectContaining({
          [CLIENT_RECIPIENT_TYPE]: expect.objectContaining({
            pushTokens: ["ExponentPushToken[cancel-cust]"],
          }),
        }),
        pushPayload: expect.objectContaining({
          title: "Your booking has been cancelled",
        }),
      });
    });

    it("delivers PUSH-only to a customer with no email or phone but active tokens", async () => {
      const booking = createBooking({
        status: BookingStatus.CONFIRMED,
        car: createCar({ owner: createOwner() }),
        chauffeur: createChauffeur(),
        user: createUser({ id: "cancel-user-2", email: "", phoneNumber: null }),
        userId: "cancel-user-2",
      });
      pushTokensByUserId.set("cancel-user-2", ["ExponentPushToken[push-only]"]);

      const { customer } = await service.buildBookingCancellationJobData(booking);

      expect(customer).toMatchObject({
        channels: [NotificationChannel.PUSH],
        recipients: expect.objectContaining({
          [CLIENT_RECIPIENT_TYPE]: expect.objectContaining({
            pushTokens: ["ExponentPushToken[push-only]"],
          }),
        }),
      });
    });

    it("includes PUSH channel for the fleet owner when they have active push tokens", async () => {
      const booking = createBooking({
        status: BookingStatus.CONFIRMED,
        car: createCar({ owner: createOwner({ id: "cancel-owner-1" }) }),
        chauffeur: createChauffeur(),
        user: createUser(),
      });
      pushTokensByUserId.set("cancel-owner-1", ["ExponentPushToken[cancel-owner]"]);

      const { owner } = await service.buildBookingCancellationJobData(booking);

      expect(owner).toMatchObject({
        type: NotificationType.BOOKING_CANCELLED,
        channels: [
          NotificationChannel.EMAIL,
          NotificationChannel.WHATSAPP,
          NotificationChannel.PUSH,
        ],
        recipients: expect.objectContaining({
          [FLEET_OWNER_RECIPIENT_TYPE]: expect.objectContaining({
            pushTokens: ["ExponentPushToken[cancel-owner]"],
          }),
        }),
        pushPayload: expect.objectContaining({
          title: "A booking for your vehicle has been cancelled",
        }),
      });
    });

    it("delivers PUSH-only to a fleet owner with no email or phone but active tokens", async () => {
      const booking = createBooking({
        status: BookingStatus.CONFIRMED,
        car: createCar({
          owner: createOwner({ id: "cancel-owner-2", email: null, phoneNumber: null }),
        }),
        chauffeur: createChauffeur(),
        user: createUser(),
      });
      pushTokensByUserId.set("cancel-owner-2", ["ExponentPushToken[owner-push-only]"]);

      const { owner } = await service.buildBookingCancellationJobData(booking);

      expect(owner).toMatchObject({
        channels: [NotificationChannel.PUSH],
        recipients: expect.objectContaining({
          [FLEET_OWNER_RECIPIENT_TYPE]: expect.objectContaining({
            pushTokens: ["ExponentPushToken[owner-push-only]"],
          }),
        }),
      });
    });
  });
});
