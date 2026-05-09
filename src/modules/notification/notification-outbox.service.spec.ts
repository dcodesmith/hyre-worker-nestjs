import { Test, type TestingModule } from "@nestjs/testing";
import { NotificationOutboxEventType, NotificationOutboxStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
import { NotificationType } from "./notification.interface";
import { NotificationService } from "./notification.service";
import {
  NotificationOutboxService,
  type NotificationOutboxTransactionClient,
} from "./notification-outbox.service";

describe("NotificationOutboxService", () => {
  let service: NotificationOutboxService;

  // The reminder writer routes inbox + outbox creates through `$transaction`.
  // The mock just invokes the callback with the same client so we can assert on
  // `notificationInbox.create`/`notificationOutboxEvent.create` directly.
  const databaseServiceMock = {
    notificationInbox: {
      create: vi.fn(),
    },
    notificationOutboxEvent: {
      create: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  };

  const notificationServiceMock = {
    buildChauffeurAssignedJobData: vi.fn(),
    buildBookingStatusChangeJobData: vi.fn(),
    buildBookingReminderJobData: vi.fn(),
    enqueuePreparedNotification: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    databaseServiceMock.$transaction.mockImplementation(
      async (callback: (tx: typeof databaseServiceMock) => Promise<unknown>) =>
        callback(databaseServiceMock),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationOutboxService,
        { provide: DatabaseService, useValue: databaseServiceMock },
        { provide: NotificationService, useValue: notificationServiceMock },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get<NotificationOutboxService>(NotificationOutboxService);
  });

  it("creates inbox and outbox records inside transaction", async () => {
    const tx = {
      notificationInbox: { create: vi.fn().mockResolvedValue(undefined) },
      notificationOutboxEvent: { create: vi.fn().mockResolvedValue(undefined) },
      userPushToken: {
        findMany: vi.fn().mockResolvedValue([{ token: "ExponentPushToken[a]" }]),
      },
    } satisfies NotificationOutboxTransactionClient;
    const booking = createBooking({
      id: "booking-1",
      userId: "user-1",
      updatedAt: new Date("2026-05-02T20:00:00.000Z"),
      user: createUser(),
      chauffeur: createChauffeur(),
      car: createCar({ owner: createOwner() }),
      legs: [],
    });
    notificationServiceMock.buildChauffeurAssignedJobData.mockResolvedValueOnce({
      id: "chauffeur-assigned-booking-1-1",
      type: "chauffeur-assigned",
      channels: ["email", "push"],
      bookingId: "booking-1",
      recipients: {
        client: {
          email: "john@example.com",
          pushTokens: ["ExponentPushToken[a]"],
        },
      },
      templateData: {
        templateKind: "bookingStatusChange",
        id: "booking-1",
        bookingReference: "REF-1",
        customerName: "John Doe",
        ownerName: "Owner Name",
        chauffeurName: "Chauffeur Name",
        chauffeurPhoneNumber: "1234567890",
        carName: "Car Name",
        pickupLocation: "Pickup",
        returnLocation: "Return",
        startDate: "2024-01-01",
        endDate: "2024-01-02",
        totalAmount: "10000",
        title: "been assigned a chauffeur",
        status: "chauffeur assigned",
        cancellationReason: "",
        oldStatus: "confirmed",
        newStatus: "chauffeur_assigned",
        subject: "Your chauffeur has been assigned",
      },
      pushPayload: {
        title: "Your chauffeur has been assigned",
        body: "Your chauffeur has been assigned.",
      },
    });

    await service.createChauffeurAssignedEvent(tx, booking, "chauffeur-1");

    expect(tx.userPushToken.findMany).toHaveBeenCalledWith({
      where: { userId: "user-1", revokedAt: null },
      select: { token: true },
    });

    expect(tx.notificationInbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "user-1",
        }),
      }),
    );
    expect(tx.notificationOutboxEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: NotificationOutboxEventType.BOOKING_ASSIGNMENT,
          bookingId: "booking-1",
          status: NotificationOutboxStatus.PENDING,
          payload: expect.objectContaining({
            schemaVersion: 2,
            subtype: "CHAUFFEUR_ASSIGNED",
          }),
        }),
      }),
    );
  });

  it("dispatches pending outbox event and marks it dispatched", async () => {
    databaseServiceMock.notificationOutboxEvent.findMany.mockResolvedValueOnce([
      {
        id: "evt-1",
        bookingId: "booking-1",
        eventType: NotificationOutboxEventType.BOOKING_ASSIGNMENT,
        status: NotificationOutboxStatus.PENDING,
        attempts: 0,
        nextAttemptAt: new Date(Date.now() - 1000),
        payload: {
          schemaVersion: 1,
          notificationJobData: {
            id: "chauffeur-assigned-booking-1-1",
            type: "chauffeur-assigned",
            channels: ["email"],
            bookingId: "booking-1",
            recipients: { client: { email: "john@example.com" } },
            templateData: {
              templateKind: "bookingStatusChange",
              id: "booking-1",
              bookingReference: "REF-1",
              customerName: "John Doe",
              ownerName: "Owner Name",
              chauffeurName: "Chauffeur Name",
              chauffeurPhoneNumber: "1234567890",
              carName: "Car Name",
              pickupLocation: "Pickup",
              returnLocation: "Return",
              startDate: "2024-01-01",
              endDate: "2024-01-02",
              totalAmount: "10000",
              title: "been assigned a chauffeur",
              status: "chauffeur assigned",
              cancellationReason: "",
              oldStatus: "confirmed",
              newStatus: "chauffeur_assigned",
              subject: "Your chauffeur has been assigned",
            },
          },
        },
      },
    ]);
    databaseServiceMock.notificationOutboxEvent.updateMany.mockResolvedValueOnce({ count: 1 });
    notificationServiceMock.enqueuePreparedNotification.mockResolvedValueOnce(undefined);

    const processedCount = await service.processPendingEvents();

    expect(processedCount).toBe(1);
    expect(notificationServiceMock.enqueuePreparedNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking-1",
      }),
      expect.objectContaining({
        jobId: "notification-outbox-evt-1",
        removeOnComplete: { age: 24 * 60 * 60 },
        removeOnFail: { age: 24 * 60 * 60 },
      }),
    );
    expect(databaseServiceMock.notificationOutboxEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "evt-1" },
        data: expect.objectContaining({
          status: NotificationOutboxStatus.DISPATCHED,
        }),
      }),
    );
  });

  it("reclaims stale PROCESSING events without incrementing attempts", async () => {
    databaseServiceMock.notificationOutboxEvent.findMany.mockResolvedValueOnce([
      {
        id: "evt-2",
        bookingId: "booking-2",
        eventType: NotificationOutboxEventType.BOOKING_ASSIGNMENT,
        status: NotificationOutboxStatus.PROCESSING,
        attempts: 1,
        nextAttemptAt: new Date(Date.now() - 1000),
        updatedAt: new Date(Date.now() - 5 * 60 * 1000),
        payload: {
          schemaVersion: 1,
          notificationJobData: {
            id: "chauffeur-assigned-booking-2-1",
            type: "chauffeur-assigned",
            channels: ["email"],
            bookingId: "booking-2",
            recipients: { client: { email: "john@example.com" } },
            templateData: {
              templateKind: "bookingStatusChange",
              id: "booking-2",
              bookingReference: "REF-2",
              customerName: "John Doe",
              ownerName: "Owner Name",
              chauffeurName: "Chauffeur Name",
              chauffeurPhoneNumber: "1234567890",
              carName: "Car Name",
              pickupLocation: "Pickup",
              returnLocation: "Return",
              startDate: "2024-01-01",
              endDate: "2024-01-02",
              totalAmount: "10000",
              title: "been assigned a chauffeur",
              status: "chauffeur assigned",
              cancellationReason: "",
              oldStatus: "confirmed",
              newStatus: "chauffeur_assigned",
              subject: "Your chauffeur has been assigned",
            },
          },
        },
      },
    ]);
    databaseServiceMock.notificationOutboxEvent.updateMany.mockResolvedValueOnce({ count: 1 });
    notificationServiceMock.enqueuePreparedNotification.mockResolvedValueOnce(undefined);

    const processedCount = await service.processPendingEvents();

    expect(processedCount).toBe(1);
    expect(databaseServiceMock.notificationOutboxEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "evt-2",
          status: NotificationOutboxStatus.PROCESSING,
        }),
        data: { status: NotificationOutboxStatus.PROCESSING },
      }),
    );
    expect(notificationServiceMock.enqueuePreparedNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking-2",
      }),
      expect.objectContaining({
        jobId: "notification-outbox-evt-2",
      }),
    );
  });

  it("marks event failed when enqueue throws", async () => {
    databaseServiceMock.notificationOutboxEvent.findMany.mockResolvedValueOnce([
      {
        id: "evt-3",
        bookingId: "booking-3",
        eventType: NotificationOutboxEventType.BOOKING_ASSIGNMENT,
        status: NotificationOutboxStatus.PENDING,
        attempts: 0,
        nextAttemptAt: new Date(Date.now() - 1000),
        payload: {
          schemaVersion: 1,
          notificationJobData: {
            id: "chauffeur-assigned-booking-3-1",
            type: "chauffeur-assigned",
            channels: ["email"],
            bookingId: "booking-3",
            recipients: { client: { email: "john@example.com" } },
            templateData: {
              templateKind: "bookingStatusChange",
              id: "booking-3",
              bookingReference: "REF-3",
              customerName: "John Doe",
              ownerName: "Owner Name",
              chauffeurName: "Chauffeur Name",
              chauffeurPhoneNumber: "1234567890",
              carName: "Car Name",
              pickupLocation: "Pickup",
              returnLocation: "Return",
              startDate: "2024-01-01",
              endDate: "2024-01-02",
              totalAmount: "10000",
              title: "been assigned a chauffeur",
              status: "chauffeur assigned",
              cancellationReason: "",
              oldStatus: "confirmed",
              newStatus: "chauffeur_assigned",
              subject: "Your chauffeur has been assigned",
            },
          },
        },
      },
    ]);
    databaseServiceMock.notificationOutboxEvent.updateMany.mockResolvedValueOnce({ count: 1 });
    notificationServiceMock.enqueuePreparedNotification.mockRejectedValueOnce(
      new Error("Queue unavailable"),
    );

    const processedCount = await service.processPendingEvents();

    expect(processedCount).toBe(0);
    expect(databaseServiceMock.notificationOutboxEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "evt-3" },
        data: expect.objectContaining({
          status: NotificationOutboxStatus.FAILED,
          lastError: "Queue unavailable",
        }),
      }),
    );
  });

  it("marks malformed payload as dead letter", async () => {
    databaseServiceMock.notificationOutboxEvent.findMany.mockResolvedValueOnce([
      {
        id: "evt-4",
        bookingId: "booking-4",
        eventType: NotificationOutboxEventType.CHAUFFEUR_ASSIGNED,
        status: NotificationOutboxStatus.PENDING,
        attempts: 0,
        nextAttemptAt: new Date(Date.now() - 1000),
        payload: { schemaVersion: 1 },
      },
    ]);
    databaseServiceMock.notificationOutboxEvent.updateMany.mockResolvedValueOnce({ count: 1 });

    const processedCount = await service.processPendingEvents();

    expect(processedCount).toBe(1);
    expect(databaseServiceMock.notificationOutboxEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "evt-4" },
        data: expect.objectContaining({
          status: NotificationOutboxStatus.DEAD_LETTER,
          lastError: "Invalid notification outbox payload",
        }),
      }),
    );
  });

  describe("createBookingStatusChangedEvent", () => {
    const buildBooking = (overrides: Parameters<typeof createBooking>[0] = {}) =>
      createBooking({
        id: "booking-status-1",
        userId: "user-1",
        chauffeurId: "chauffeur-1",
        updatedAt: new Date("2026-05-09T10:00:00.000Z"),
        user: createUser(),
        chauffeur: createChauffeur(),
        car: createCar({ owner: createOwner() }),
        legs: [],
        ...overrides,
      });

    const buildJobData = (bookingId: string) => ({
      id: `status-${bookingId}-1`,
      type: "booking-status-change",
      channels: ["email", "push"],
      bookingId,
      recipients: { client: { email: "client@example.com", pushTokens: ["tok"] } },
      templateData: { templateKind: "bookingStatusChange" },
    });

    it("writes inbox + outbox in the provided tx and short-circuits when no job data", async () => {
      const tx = {
        notificationInbox: { create: vi.fn().mockResolvedValue(undefined) },
        notificationOutboxEvent: { create: vi.fn().mockResolvedValue(undefined) },
        userPushToken: { findMany: vi.fn() },
      } satisfies NotificationOutboxTransactionClient;
      const booking = buildBooking();
      notificationServiceMock.buildBookingStatusChangeJobData.mockResolvedValueOnce(
        buildJobData(booking.id),
      );

      await service.createBookingStatusChangedEvent(tx, booking, "CONFIRMED", "ACTIVE");

      expect(notificationServiceMock.buildBookingStatusChangeJobData).toHaveBeenCalledWith({
        booking,
        oldStatus: "CONFIRMED",
        newStatus: "ACTIVE",
        showReviewRequest: false,
      });
      expect(tx.notificationInbox.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: "user-1",
            type: "BOOKING_LIFECYCLE",
            payload: expect.objectContaining({
              bookingId: booking.id,
              oldStatus: "CONFIRMED",
              newStatus: "ACTIVE",
            }),
          }),
        }),
      );
      expect(tx.notificationOutboxEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: "user-1",
            eventType: NotificationOutboxEventType.BOOKING_LIFECYCLE,
            status: NotificationOutboxStatus.PENDING,
            bookingId: booking.id,
            dedupeKey: `booking-status:${booking.id}:CONFIRMED:ACTIVE:${booking.updatedAt.toISOString()}`,
            payload: expect.objectContaining({
              schemaVersion: 2,
              eventType: NotificationOutboxEventType.BOOKING_LIFECYCLE,
              subtype: "BOOKING_STATUS_CHANGED",
            }),
          }),
        }),
      );
      // Database-service writers must not be touched when a tx is supplied.
      expect(databaseServiceMock.notificationInbox.create).not.toHaveBeenCalled();
      expect(databaseServiceMock.notificationOutboxEvent.create).not.toHaveBeenCalled();
    });

    it("skips both writes when buildBookingStatusChangeJobData returns null", async () => {
      const tx = {
        notificationInbox: { create: vi.fn() },
        notificationOutboxEvent: { create: vi.fn() },
        userPushToken: { findMany: vi.fn() },
      } satisfies NotificationOutboxTransactionClient;
      notificationServiceMock.buildBookingStatusChangeJobData.mockResolvedValueOnce(null);

      await service.createBookingStatusChangedEvent(
        tx,
        buildBooking(),
        "CONFIRMED",
        "ACTIVE",
        true,
      );

      expect(tx.notificationInbox.create).not.toHaveBeenCalled();
      expect(tx.notificationOutboxEvent.create).not.toHaveBeenCalled();
    });

    it("omits the inbox write when the booking has no userId", async () => {
      const tx = {
        notificationInbox: { create: vi.fn().mockResolvedValue(undefined) },
        notificationOutboxEvent: { create: vi.fn().mockResolvedValue(undefined) },
        userPushToken: { findMany: vi.fn() },
      } satisfies NotificationOutboxTransactionClient;
      const guestBooking = buildBooking({ userId: null, user: null });
      notificationServiceMock.buildBookingStatusChangeJobData.mockResolvedValueOnce(
        buildJobData(guestBooking.id),
      );

      await service.createBookingStatusChangedEvent(tx, guestBooking, "ACTIVE", "COMPLETED");

      expect(tx.notificationInbox.create).not.toHaveBeenCalled();
      expect(tx.notificationOutboxEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: null,
            eventType: NotificationOutboxEventType.BOOKING_LIFECYCLE,
          }),
        }),
      );
    });
  });

  describe("createBookingReminderEventsForLeg", () => {
    const buildLeg = (overrides: Parameters<typeof createBooking>[0] = {}) => {
      const booking = createBooking({
        id: "booking-reminder-1",
        userId: "user-1",
        chauffeurId: "chauffeur-1",
        updatedAt: new Date("2026-05-09T10:00:00.000Z"),
        user: createUser(),
        chauffeur: createChauffeur(),
        car: createCar({ owner: createOwner() }),
        ...overrides,
      });
      const leg = createBookingLeg({
        id: "leg-reminder-1",
        bookingId: booking.id,
        updatedAt: new Date("2026-05-09T10:00:00.000Z"),
      });
      // BookingLegWithRelations expects a populated `booking` field.
      return Object.assign(leg, { booking });
    };

    it("writes inbox + outbox per recipient inside a single transaction", async () => {
      const leg = buildLeg();
      notificationServiceMock.buildBookingReminderJobData.mockResolvedValueOnce([
        {
          id: "reminder-client-1",
          type: NotificationType.BOOKING_REMINDER_START,
          channels: ["email", "push"],
          bookingId: leg.booking.id,
          recipients: { client: { email: "client@example.com", pushTokens: ["tok"] } },
          templateData: { templateKind: "bookingReminder" },
        },
        {
          id: "reminder-chauffeur-1",
          type: NotificationType.BOOKING_REMINDER_START,
          channels: ["email"],
          bookingId: leg.booking.id,
          recipients: { chauffeur: { email: "chauffeur@example.com" } },
          templateData: { templateKind: "bookingReminder" },
        },
      ]);

      const written = await service.createBookingReminderEventsForLeg(
        leg,
        NotificationType.BOOKING_REMINDER_START,
      );

      expect(written).toBe(2);
      expect(databaseServiceMock.$transaction).toHaveBeenCalledTimes(2);
      // Reminder context is forwarded so push delivery isn't silently dropped.
      expect(notificationServiceMock.buildBookingReminderJobData).toHaveBeenCalledWith(
        expect.objectContaining({ bookingId: leg.booking.id }),
        NotificationType.BOOKING_REMINDER_START,
        { customerUserId: "user-1", chauffeurUserId: "chauffeur-1" },
      );

      const inboxCalls = databaseServiceMock.notificationInbox.create.mock.calls.map(
        ([arg]) => arg.data,
      );
      expect(inboxCalls).toHaveLength(2);
      expect(inboxCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            userId: "user-1",
            type: "BOOKING_REMINDER",
            title: "Booking starts in 1 hour",
            payload: expect.objectContaining({ recipientType: "client" }),
          }),
          expect.objectContaining({
            userId: "chauffeur-1",
            type: "BOOKING_REMINDER",
            payload: expect.objectContaining({ recipientType: "chauffeur" }),
          }),
        ]),
      );

      const outboxCalls = databaseServiceMock.notificationOutboxEvent.create.mock.calls.map(
        ([arg]) => arg.data,
      );
      expect(outboxCalls).toHaveLength(2);
      for (const data of outboxCalls) {
        expect(data).toMatchObject({
          eventType: NotificationOutboxEventType.BOOKING_REMINDER,
          status: NotificationOutboxStatus.PENDING,
          bookingId: leg.booking.id,
          payload: expect.objectContaining({
            schemaVersion: 2,
            subtype: "BOOKING_REMINDER_START",
          }),
        });
      }
      expect(outboxCalls.map((d) => d.dedupeKey)).toEqual(
        expect.arrayContaining([
          `booking-reminder:${leg.id}:client:${NotificationType.BOOKING_REMINDER_START}:${leg.updatedAt.toISOString()}`,
          `booking-reminder:${leg.id}:chauffeur:${NotificationType.BOOKING_REMINDER_START}:${leg.updatedAt.toISOString()}`,
        ]),
      );
    });

    it("uses BOOKING_REMINDER_END subtype and chauffeur-only path when customer is missing", async () => {
      const leg = buildLeg({ userId: null, user: null });
      notificationServiceMock.buildBookingReminderJobData.mockResolvedValueOnce([
        {
          id: "reminder-chauffeur-2",
          type: NotificationType.BOOKING_REMINDER_END,
          channels: ["email", "push"],
          bookingId: leg.booking.id,
          recipients: { chauffeur: { email: "chauffeur@example.com", pushTokens: ["tok"] } },
          templateData: { templateKind: "bookingReminder" },
        },
      ]);

      const written = await service.createBookingReminderEventsForLeg(
        leg,
        NotificationType.BOOKING_REMINDER_END,
      );

      expect(written).toBe(1);
      expect(databaseServiceMock.$transaction).toHaveBeenCalledTimes(1);
      expect(notificationServiceMock.buildBookingReminderJobData).toHaveBeenCalledWith(
        expect.anything(),
        NotificationType.BOOKING_REMINDER_END,
        { customerUserId: undefined, chauffeurUserId: "chauffeur-1" },
      );
      expect(databaseServiceMock.notificationInbox.create).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: "chauffeur-1",
            title: "Booking ends in 1 hour",
            body: "Your booking is ending soon.",
          }),
        }),
      );
      expect(databaseServiceMock.notificationOutboxEvent.create).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: "chauffeur-1",
            payload: expect.objectContaining({ subtype: "BOOKING_REMINDER_END" }),
          }),
        }),
      );
    });

    it("omits inbox write when no userId can be resolved for the recipient", async () => {
      const leg = buildLeg();
      // Recipient that doesn't map to customer/chauffeur (e.g. fleet owner) — defensive case.
      notificationServiceMock.buildBookingReminderJobData.mockResolvedValueOnce([
        {
          id: "reminder-other-1",
          type: NotificationType.BOOKING_REMINDER_START,
          channels: ["email"],
          bookingId: leg.booking.id,
          recipients: { fleetOwner: { email: "owner@example.com" } },
          templateData: { templateKind: "bookingReminder" },
        },
      ]);

      const written = await service.createBookingReminderEventsForLeg(
        leg,
        NotificationType.BOOKING_REMINDER_START,
      );

      expect(written).toBe(1);
      expect(databaseServiceMock.notificationInbox.create).not.toHaveBeenCalled();
      expect(databaseServiceMock.notificationOutboxEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ userId: null }),
        }),
      );
    });
  });
});
