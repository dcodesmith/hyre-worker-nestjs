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
  createExtension,
  createOwner,
  createUser,
} from "../../shared/helper.fixtures";
import type { ExtensionWithNotificationRelations } from "../../types";
import {
  CHAUFFEUR_RECIPIENT_TYPE,
  CLIENT_RECIPIENT_TYPE,
  FLEET_OWNER_RECIPIENT_TYPE,
} from "./notification.const";
import {
  NotificationAudience,
  NotificationChannel,
  NotificationJobData,
  NotificationType,
} from "./notification.interface";
import { NotificationService } from "./notification.service";
import { RecipientChannelResolverService } from "./recipient-channel-resolver.service";
import {
  BOOKING_CONFIRMED_TEMPLATE_KIND,
  BOOKING_EXTENSION_CONFIRMED_TEMPLATE_KIND,
  BOOKING_REMINDER_TEMPLATE_KIND,
  BOOKING_STATUS_TEMPLATE_KIND,
  FLEET_OWNER_NEW_BOOKING_TEMPLATE_KIND,
} from "./template-data.interface";

describe("NotificationService", () => {
  let service: NotificationService;
  let mockQueue: Partial<Queue<NotificationJobData>>;

  beforeEach(async () => {
    vi.clearAllMocks();

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
          useClass: RecipientChannelResolverService,
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get<NotificationService>(NotificationService);
  });
  describe("buildBookingStatusChangeJobData", () => {
    it("returns email + whatsapp + push channels for a registered customer", async () => {
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
        audience: NotificationAudience.CUSTOMER,
        channels: [
          NotificationChannel.EMAIL,
          NotificationChannel.WHATSAPP,
          NotificationChannel.PUSH,
        ],
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
        userId: null,
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
        userId: null,
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
        userId: null,
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

    it("stores the customer user ID instead of a push-token snapshot", async () => {
      const booking = createBooking({
        status: BookingStatus.ACTIVE,
        car: createCar({ owner: createOwner() }),
        chauffeur: createChauffeur(),
        user: createUser({ id: "status-user-1" }),
        userId: "status-user-1",
      });
      const jobData = await service.buildBookingStatusChangeJobData({
        booking,
        oldStatus: BookingStatus.CONFIRMED,
        newStatus: BookingStatus.ACTIVE,
      });

      expect(jobData).toMatchObject({
        audience: NotificationAudience.CUSTOMER,
        channels: [
          NotificationChannel.EMAIL,
          NotificationChannel.WHATSAPP,
          NotificationChannel.PUSH,
        ],
        recipients: expect.objectContaining({
          [CLIENT_RECIPIENT_TYPE]: expect.objectContaining({
            userId: "status-user-1",
          }),
        }),
      });
      expect(jobData?.recipients[CLIENT_RECIPIENT_TYPE]).not.toHaveProperty("pushTokens");
    });
  });

  describe("buildBookingConfirmedJobData", () => {
    it("builds customer push/email/whatsapp and fleet-owner email jobs", async () => {
      const booking = createBooking({
        id: "booking-confirmed-1",
        userId: "customer-1",
        user: createUser({ id: "customer-1" }),
        car: createCar({
          owner: createOwner({
            id: "owner-1",
            email: "owner@example.com",
            phoneNumber: null,
          }),
        }),
      });

      const { customer, owner } = await service.buildBookingConfirmedJobData(booking);

      expect(customer).toMatchObject({
        type: NotificationType.BOOKING_CONFIRMED,
        audience: NotificationAudience.CUSTOMER,
        channels: [
          NotificationChannel.EMAIL,
          NotificationChannel.WHATSAPP,
          NotificationChannel.PUSH,
        ],
        recipients: {
          [CLIENT_RECIPIENT_TYPE]: expect.objectContaining({ userId: "customer-1" }),
        },
        templateData: expect.objectContaining({
          templateKind: BOOKING_CONFIRMED_TEMPLATE_KIND,
        }),
      });
      expect(owner).toMatchObject({
        type: NotificationType.FLEET_OWNER_NEW_BOOKING,
        audience: NotificationAudience.FLEET_OWNER,
        channels: [NotificationChannel.EMAIL],
        recipients: {
          [FLEET_OWNER_RECIPIENT_TYPE]: expect.objectContaining({
            userId: "owner-1",
            email: "owner@example.com",
          }),
        },
        templateData: expect.objectContaining({
          templateKind: FLEET_OWNER_NEW_BOOKING_TEMPLATE_KIND,
        }),
      });
    });

    it("returns null jobs when a guest and fleet owner have no delivery channels", async () => {
      const booking = createBooking({
        userId: null,
        user: null,
        guestUser: {
          name: "No Contact Guest",
          email: null,
          phoneNumber: null,
          guestContactSource: "WEB_GUEST_FORM",
          preferredNotificationChannel: "EMAIL_AND_WHATSAPP",
        },
        car: createCar({
          owner: createOwner({ email: null, phoneNumber: null }),
        }),
      });

      await expect(service.buildBookingConfirmedJobData(booking)).resolves.toEqual({
        customer: null,
        owner: null,
      });
    });
  });

  describe("buildBookingExtensionConfirmedJobData", () => {
    it("builds email, WhatsApp and push delivery for a registered customer", async () => {
      const booking = createBooking({
        id: "booking-1",
        userId: "customer-1",
        user: createUser({ id: "customer-1" }),
        car: createCar({ owner: createOwner() }),
      });
      const extension = {
        ...createExtension({ id: "extension-1" }),
        bookingLeg: { ...createBookingLeg(), booking },
      } as ExtensionWithNotificationRelations;

      const jobData = await service.buildBookingExtensionConfirmedJobData(extension);

      expect(jobData).toMatchObject({
        id: "booking-extension-confirmed-extension-1",
        type: NotificationType.BOOKING_EXTENSION_CONFIRMED,
        audience: NotificationAudience.CUSTOMER,
        channels: [
          NotificationChannel.EMAIL,
          NotificationChannel.WHATSAPP,
          NotificationChannel.PUSH,
        ],
        bookingId: "booking-1",
        recipients: {
          [CLIENT_RECIPIENT_TYPE]: expect.objectContaining({ userId: "customer-1" }),
        },
        pushPayload: {
          title: "Booking extension confirmed",
          body: "Your booking has been extended by 2 hours.",
          data: {
            bookingId: "booking-1",
            extensionId: "extension-1",
            type: NotificationType.BOOKING_EXTENSION_CONFIRMED,
          },
        },
        templateData: expect.objectContaining({
          templateKind: BOOKING_EXTENSION_CONFIRMED_TEMPLATE_KIND,
          subject: "Booking Extension Confirmed",
        }),
      });
    });

    it("builds WhatsApp-only delivery for a WhatsApp-agent guest", async () => {
      const booking = createBooking({
        id: "booking-2",
        userId: null,
        user: null,
        guestUser: {
          name: "WhatsApp Guest",
          email: "whatsapp.2348012345678@tripdly.com",
          phoneNumber: "+2348012345678",
          guestContactSource: "WHATSAPP_AGENT",
          preferredNotificationChannel: "WHATSAPP_ONLY",
        },
        car: createCar({ owner: createOwner() }),
      });
      const extension = {
        ...createExtension({ id: "extension-2" }),
        bookingLeg: { ...createBookingLeg(), booking },
      } as ExtensionWithNotificationRelations;

      const jobData = await service.buildBookingExtensionConfirmedJobData(extension);

      expect(jobData).toMatchObject({
        channels: [NotificationChannel.WHATSAPP],
        recipients: {
          [CLIENT_RECIPIENT_TYPE]: expect.objectContaining({
            userId: undefined,
            email: undefined,
            phoneNumber: "+2348012345678",
          }),
        },
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
        audience: NotificationAudience.CUSTOMER,
        channels: [
          NotificationChannel.EMAIL,
          NotificationChannel.WHATSAPP,
          NotificationChannel.PUSH,
        ],
        bookingId: booking.id,
        recipients: expect.objectContaining({
          [CLIENT_RECIPIENT_TYPE]: expect.objectContaining({
            userId: "client-11",
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
        audience: NotificationAudience.CHAUFFEUR,
        channels: [NotificationChannel.EMAIL, NotificationChannel.WHATSAPP],
        recipients: expect.objectContaining({
          [CHAUFFEUR_RECIPIENT_TYPE]: expect.objectContaining({
            userId: "chauffeur-22",
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

    it("schedules customer push but keeps chauffeur push disabled", async () => {
      const booking = createBooking({
        car: createCar({ owner: createOwner() }),
        chauffeur: createChauffeur({ id: "chauffeur-22" }),
        chauffeurId: "chauffeur-22",
        user: createUser({ id: "client-11" }),
        userId: "client-11",
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

      expect(jobs[0]).toMatchObject({
        channels: [
          NotificationChannel.EMAIL,
          NotificationChannel.WHATSAPP,
          NotificationChannel.PUSH,
        ],
        recipients: expect.objectContaining({
          [CLIENT_RECIPIENT_TYPE]: expect.objectContaining({
            userId: "client-11",
          }),
        }),
      });
      expect(jobs[1]).toMatchObject({
        channels: [NotificationChannel.EMAIL, NotificationChannel.WHATSAPP],
        recipients: expect.objectContaining({
          [CHAUFFEUR_RECIPIENT_TYPE]: expect.objectContaining({
            userId: "chauffeur-22",
          }),
        }),
      });
      expect(jobs[0]?.recipients[CLIENT_RECIPIENT_TYPE]).not.toHaveProperty("pushTokens");
      expect(jobs[1]?.recipients[CHAUFFEUR_RECIPIENT_TYPE]).not.toHaveProperty("pushTokens");
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
        audience: NotificationAudience.CUSTOMER,
        channels: [
          NotificationChannel.EMAIL,
          NotificationChannel.WHATSAPP,
          NotificationChannel.PUSH,
        ],
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

    it("stores the customer user ID for delivery-time push resolution", async () => {
      const booking = createBooking({
        status: BookingStatus.CONFIRMED,
        car: createCar({ owner: createOwner() }),
        chauffeur: createChauffeur(),
        user: createUser(),
      });
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
            userId: booking.userId,
          }),
        }),
        pushPayload: expect.objectContaining({
          title: "Your chauffeur has been assigned",
        }),
      });
      expect(jobData?.recipients[CLIENT_RECIPIENT_TYPE]).not.toHaveProperty("pushTokens");
    });

    it("returns null when the customer has no deliverable channels", async () => {
      const booking = createBooking({
        status: BookingStatus.CONFIRMED,
        car: createCar({ owner: createOwner() }),
        chauffeur: createChauffeur(),
        user: null,
        userId: null,
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
        audience: NotificationAudience.CUSTOMER,
        channels: [
          NotificationChannel.EMAIL,
          NotificationChannel.WHATSAPP,
          NotificationChannel.PUSH,
        ],
        bookingId: booking.id,
        templateData: expect.objectContaining({
          subject: "Your booking has been cancelled",
        }),
      });
      expect(owner).toMatchObject({
        type: NotificationType.BOOKING_CANCELLED,
        audience: NotificationAudience.FLEET_OWNER,
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
        userId: null,
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

    it("includes customer PUSH without storing a token snapshot", async () => {
      const booking = createBooking({
        status: BookingStatus.CONFIRMED,
        car: createCar({ owner: createOwner() }),
        chauffeur: createChauffeur(),
        user: createUser({ id: "cancel-user-1" }),
        userId: "cancel-user-1",
      });
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
            userId: "cancel-user-1",
          }),
        }),
        pushPayload: expect.objectContaining({
          title: "Your booking has been cancelled",
        }),
      });
      expect(customer?.recipients[CLIENT_RECIPIENT_TYPE]).not.toHaveProperty("pushTokens");
    });

    it("schedules PUSH-only for a registered customer with no email or phone", async () => {
      const booking = createBooking({
        status: BookingStatus.CONFIRMED,
        car: createCar({ owner: createOwner() }),
        chauffeur: createChauffeur(),
        user: createUser({ id: "cancel-user-2", email: "", phoneNumber: null }),
        userId: "cancel-user-2",
      });
      const { customer } = await service.buildBookingCancellationJobData(booking);

      expect(customer).toMatchObject({
        channels: [NotificationChannel.PUSH],
        recipients: expect.objectContaining({
          [CLIENT_RECIPIENT_TYPE]: expect.objectContaining({
            userId: "cancel-user-2",
          }),
        }),
      });
    });

    it("does not schedule PUSH for fleet owners before their client is supported", async () => {
      const booking = createBooking({
        status: BookingStatus.CONFIRMED,
        car: createCar({ owner: createOwner({ id: "cancel-owner-1" }) }),
        chauffeur: createChauffeur(),
        user: createUser(),
      });
      const { owner } = await service.buildBookingCancellationJobData(booking);

      expect(owner).toMatchObject({
        type: NotificationType.BOOKING_CANCELLED,
        audience: NotificationAudience.FLEET_OWNER,
        channels: [NotificationChannel.EMAIL, NotificationChannel.WHATSAPP],
        recipients: expect.objectContaining({
          [FLEET_OWNER_RECIPIENT_TYPE]: expect.objectContaining({
            userId: "cancel-owner-1",
          }),
        }),
        pushPayload: expect.objectContaining({
          title: "A booking for your vehicle has been cancelled",
        }),
      });
      expect(owner?.recipients[FLEET_OWNER_RECIPIENT_TYPE]).not.toHaveProperty("pushTokens");
    });

    it("does not create a push-only fleet-owner job before their client is supported", async () => {
      const booking = createBooking({
        status: BookingStatus.CONFIRMED,
        car: createCar({
          owner: createOwner({ id: "cancel-owner-2", email: null, phoneNumber: null }),
        }),
        chauffeur: createChauffeur(),
        user: createUser(),
      });
      const { owner } = await service.buildBookingCancellationJobData(booking);

      expect(owner).toBeNull();
    });
  });
});
