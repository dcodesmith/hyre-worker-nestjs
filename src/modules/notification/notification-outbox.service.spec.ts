import { Test, type TestingModule } from "@nestjs/testing";
import { NotificationOutboxEventType, NotificationOutboxStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import {
  createBooking,
  createCar,
  createChauffeur,
  createOwner,
  createUser,
} from "../../shared/helper.fixtures";
import type { BookingWithRelations } from "../../types";
import { DatabaseService } from "../database/database.service";
import { NotificationService } from "./notification.service";
import {
  NotificationOutboxService,
  type NotificationOutboxTransactionClient,
} from "./notification-outbox.service";

describe("NotificationOutboxService", () => {
  let service: NotificationOutboxService;

  const databaseServiceMock = {
    notificationOutboxEvent: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
  };

  const notificationServiceMock = {
    buildChauffeurAssignedJobData: vi.fn(),
    enqueuePreparedNotification: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();

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
          eventType: NotificationOutboxEventType.CHAUFFEUR_ASSIGNED,
          bookingId: "booking-1",
          status: NotificationOutboxStatus.PENDING,
          payload: expect.objectContaining({
            schemaVersion: 1,
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
        eventType: NotificationOutboxEventType.CHAUFFEUR_ASSIGNED,
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
        eventType: NotificationOutboxEventType.CHAUFFEUR_ASSIGNED,
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
        eventType: NotificationOutboxEventType.CHAUFFEUR_ASSIGNED,
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
});
