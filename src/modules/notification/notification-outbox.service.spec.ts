import { Test, type TestingModule } from "@nestjs/testing";
import { NotificationOutboxEventType, NotificationOutboxStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { DatabaseService } from "../database/database.service";
import type { HandlerEvent, OutboxEventHandler } from "./handlers/outbox-event-handler.interface";
import { NotificationService } from "./notification.service";
import {
  NotificationOutboxService,
  type NotificationOutboxTransactionClient,
} from "./notification-outbox.service";

// Shared by both `processPendingEvents` and `concurrent claim contention` —
// the latter needs a parseable v2 outbox payload to walk the success path.
const buildJobPayload = (bookingId: string) => ({
  eventType: NotificationOutboxEventType.BOOKING_ASSIGNMENT,
  subtype: "CHAUFFEUR_ASSIGNED",
  notificationJobData: {
    id: `chauffeur-assigned-${bookingId}-1`,
    type: "chauffeur-assigned",
    channels: ["email"],
    bookingId,
    recipients: { client: { email: "john@example.com" } },
    templateData: {
      templateKind: "bookingStatusChange",
      id: bookingId,
      bookingReference: "REF",
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
});

describe("NotificationOutboxService", () => {
  let service: NotificationOutboxService;

  const databaseServiceMock = {
    notificationInbox: {
      createMany: vi.fn(),
    },
    notificationOutboxEvent: {
      createMany: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  };

  const notificationServiceMock = {
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

  // Per-handler shape behaviour is covered by the per-handler specs. These
  // orchestrator tests cover only the contract `create()` exposes — fan-out,
  // tx-vs-no-tx routing, and the "inbox-only / outbox-only / both" matrix.
  describe("create()", () => {
    const buildSampleJobData = (bookingId: string) => ({
      id: `job-${bookingId}-1`,
      type: "chauffeur-assigned" as const,
      channels: ["email"] as const,
      bookingId,
      recipients: { client: { email: "client@example.com" } },
      templateData: { templateKind: "bookingStatusChange" } as Record<string, unknown>,
    });

    const buildHandler = <TInput>(
      events: HandlerEvent[],
      eventType: NotificationOutboxEventType = NotificationOutboxEventType.BOOKING_ASSIGNMENT,
    ): OutboxEventHandler<TInput> => ({
      eventType,
      buildEvents: vi.fn().mockResolvedValue(events),
    });

    it("writes inbox + outbox inside the supplied transaction", async () => {
      const tx = {
        notificationInbox: { createMany: vi.fn().mockResolvedValue(undefined) },
        notificationOutboxEvent: { createMany: vi.fn().mockResolvedValue(undefined) },
      } satisfies NotificationOutboxTransactionClient;
      const handler = buildHandler([
        {
          jobData: buildSampleJobData("booking-1") as never,
          inbox: {
            userId: "user-1",
            type: "BOOKING_ASSIGNMENT",
            title: "Your chauffeur has been assigned",
            body: "...",
            payload: { bookingId: "booking-1" },
          },
          dedupeKey: "chauffeur-assigned:booking-1:chauffeur-1:t",
          userId: "user-1",
          subtype: "CHAUFFEUR_ASSIGNED",
        },
      ]);

      const written = await service.create(handler, { booking: "booking-1" }, tx);

      expect(written).toBe(1);
      expect(handler.buildEvents).toHaveBeenCalledWith({ booking: "booking-1" });
      expect(tx.notificationInbox.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [
            expect.objectContaining({
              userId: "user-1",
              type: "BOOKING_ASSIGNMENT",
              dedupeKey: "chauffeur-assigned:booking-1:chauffeur-1:t",
            }),
          ],
          skipDuplicates: true,
        }),
      );
      expect(tx.notificationOutboxEvent.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [
            expect.objectContaining({
              userId: "user-1",
              eventType: NotificationOutboxEventType.BOOKING_ASSIGNMENT,
              status: NotificationOutboxStatus.PENDING,
              dedupeKey: "chauffeur-assigned:booking-1:chauffeur-1:t",
              payload: expect.objectContaining({ subtype: "CHAUFFEUR_ASSIGNED" }),
            }),
          ],
          skipDuplicates: true,
        }),
      );
      // Database-level writers must not be touched when a tx is supplied.
      expect(databaseServiceMock.notificationInbox.createMany).not.toHaveBeenCalled();
      expect(databaseServiceMock.notificationOutboxEvent.createMany).not.toHaveBeenCalled();
    });

    it("opens its own transaction per event when no tx is supplied", async () => {
      const handler = buildHandler([
        {
          jobData: buildSampleJobData("b-1") as never,
          dedupeKey: "k-1",
          userId: "u-1",
          subtype: "X",
        },
        {
          jobData: buildSampleJobData("b-2") as never,
          dedupeKey: "k-2",
          userId: "u-2",
          subtype: "X",
        },
      ]);

      const written = await service.create(handler, {});

      expect(written).toBe(2);
      // Two events → two short-lived transactions.
      expect(databaseServiceMock.$transaction).toHaveBeenCalledTimes(2);
      expect(databaseServiceMock.notificationOutboxEvent.createMany).toHaveBeenCalledTimes(2);
    });

    // Regression: outbox writes must be idempotent on `dedupeKey`.
    //
    // Scenario (reminder cron path, no tx supplied to `create()`):
    //   Tick 1 — handler emits two events (customer + chauffeur). The customer
    //   write commits in its own tx; the chauffeur write's tx fails for a
    //   transient reason. The for-loop throws and the chauffeur row is missing.
    //   Tick 2 — handler rebuilds the same two events with the SAME dedupe
    //   keys (anchor unchanged). The customer row is already in the DB.
    //
    // Pre-fix (`outbox.create`): Postgres rejects the customer rewrite with
    // P2002, the loop aborts, and the chauffeur event is permanently stranded.
    //
    // Post-fix (`outbox.createMany({ skipDuplicates: true })`): the customer
    // re-insert is a silent no-op (`INSERT ... ON CONFLICT DO NOTHING`), the
    // loop continues, and the chauffeur row commits.
    it("recovers the missing event on retry after a partial failure mid-fanout", async () => {
      const handler = buildHandler([
        {
          jobData: buildSampleJobData("b-1") as never,
          dedupeKey: "booking-reminder:leg-1:client:anchor",
          userId: "u-customer",
          subtype: "BOOKING_REMINDER_START",
        },
        {
          jobData: buildSampleJobData("b-1") as never,
          dedupeKey: "booking-reminder:leg-1:chauffeur:anchor",
          userId: "u-chauffeur",
          subtype: "BOOKING_REMINDER_START",
        },
      ]);

      // Tick 1: customer commits, chauffeur fails transiently. The thrown
      // error must propagate so the caller can mark the leg as still pending.
      databaseServiceMock.notificationOutboxEvent.createMany
        .mockResolvedValueOnce({ count: 1 })
        .mockRejectedValueOnce(new Error("connection terminated"));

      await expect(service.create(handler, {})).rejects.toThrow("connection terminated");
      expect(databaseServiceMock.notificationOutboxEvent.createMany).toHaveBeenCalledTimes(2);

      // Tick 2: anchor unchanged ⇒ same dedupe keys. Customer becomes a
      // duplicate (count: 0), chauffeur commits (count: 1). Returned count
      // is the number of events processed (2), not rows inserted.
      databaseServiceMock.notificationOutboxEvent.createMany
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 });

      const writtenOnRetry = await service.create(handler, {});

      expect(writtenOnRetry).toBe(2);
      expect(databaseServiceMock.notificationOutboxEvent.createMany).toHaveBeenCalledTimes(4);
      // Every outbox write — including retries — must use the idempotent shape.
      for (const [call] of databaseServiceMock.notificationOutboxEvent.createMany.mock.calls) {
        expect(call).toEqual(expect.objectContaining({ skipDuplicates: true }));
      }
    });

    it("writes the inbox row even when there is no jobData (Issue 5A)", async () => {
      const handler = buildHandler([
        {
          inbox: {
            userId: "user-1",
            type: "BOOKING_LIFECYCLE",
            title: "Booking status updated",
            body: "...",
            payload: { bookingId: "b-1" },
          },
          dedupeKey: "k-noop",
          userId: "user-1",
          subtype: "BOOKING_STATUS_CHANGED",
        },
      ]);

      const written = await service.create(handler, {});

      expect(written).toBe(1);
      expect(databaseServiceMock.notificationInbox.createMany).toHaveBeenCalledTimes(1);
      expect(databaseServiceMock.notificationInbox.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [expect.objectContaining({ dedupeKey: "k-noop" })],
          skipDuplicates: true,
        }),
      );
      expect(databaseServiceMock.notificationOutboxEvent.createMany).not.toHaveBeenCalled();
    });

    it("writes the outbox row even when there is no inbox (guest booking)", async () => {
      const handler = buildHandler([
        {
          jobData: buildSampleJobData("b-1") as never,
          dedupeKey: "k-guest",
          userId: null,
          subtype: "X",
        },
      ]);

      const written = await service.create(handler, {});

      expect(written).toBe(1);
      expect(databaseServiceMock.notificationInbox.createMany).not.toHaveBeenCalled();
      expect(databaseServiceMock.notificationOutboxEvent.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [expect.objectContaining({ userId: null })],
          skipDuplicates: true,
        }),
      );
    });

    it("returns 0 and writes nothing when the handler emits no events", async () => {
      const handler = buildHandler([]);

      const written = await service.create(handler, {});

      expect(written).toBe(0);
      expect(databaseServiceMock.$transaction).not.toHaveBeenCalled();
      expect(databaseServiceMock.notificationOutboxEvent.createMany).not.toHaveBeenCalled();
    });

    it("serializes outbox payload without nested undefined (JSON-safe for Prisma)", async () => {
      const jobWithOptionals = {
        id: "job-1",
        type: "booking-reminder-start" as const,
        channels: ["push" as const],
        bookingId: "b-1",
        pushPayload: undefined,
        priority: undefined,
        recipients: {
          client: {
            email: undefined,
            phoneNumber: undefined,
            pushTokens: ["t1"],
          },
        },
        templateData: { templateKind: "bookingStatusChange" } as Record<string, unknown>,
      };

      const handler = buildHandler(
        [
          {
            jobData: jobWithOptionals as never,
            dedupeKey: "k",
            userId: "u-1",
            subtype: "BOOKING_REMINDER_START",
          },
        ],
        NotificationOutboxEventType.BOOKING_REMINDER,
      );

      await service.create(handler, {});

      const call = databaseServiceMock.notificationOutboxEvent.createMany.mock.calls[0]?.[0];
      expect(call).toBeDefined();
      const payload = call?.data[0]?.payload as Record<string, unknown>;
      const hasUndefined = (v: unknown): boolean => {
        if (v === undefined) {
          return true;
        }
        if (v === null || typeof v !== "object") {
          return false;
        }
        if (Array.isArray(v)) {
          return v.some(hasUndefined);
        }
        return Object.values(v).some(hasUndefined);
      };
      expect(hasUndefined(payload)).toBe(false);

      const nested = payload.notificationJobData as Record<string, unknown>;
      expect(nested.pushPayload).toBeUndefined();
      expect(Object.hasOwn(nested, "pushPayload")).toBe(false);
      const client = (nested.recipients as Record<string, Record<string, unknown>>).client;
      expect(Object.hasOwn(client, "email")).toBe(false);
      expect(client.pushTokens).toEqual(["t1"]);
    });
  });

  describe("processPendingEvents()", () => {
    it("dispatches a pending event and marks it dispatched", async () => {
      databaseServiceMock.notificationOutboxEvent.findMany.mockResolvedValueOnce([
        {
          id: "evt-1",
          bookingId: "booking-1",
          eventType: NotificationOutboxEventType.BOOKING_ASSIGNMENT,
          status: NotificationOutboxStatus.PENDING,
          attempts: 0,
          nextAttemptAt: new Date(Date.now() - 1000),
          payload: buildJobPayload("booking-1"),
        },
      ]);
      databaseServiceMock.notificationOutboxEvent.updateMany.mockResolvedValueOnce({ count: 1 });
      notificationServiceMock.enqueuePreparedNotification.mockResolvedValueOnce(undefined);

      const processed = await service.processPendingEvents();

      expect(processed).toBe(1);
      expect(notificationServiceMock.enqueuePreparedNotification).toHaveBeenCalledWith(
        expect.objectContaining({ bookingId: "booking-1" }),
        expect.objectContaining({
          jobId: "notification-outbox-evt-1",
          removeOnComplete: { age: 24 * 60 * 60 },
          removeOnFail: { age: 24 * 60 * 60 },
        }),
      );
      expect(databaseServiceMock.notificationOutboxEvent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "evt-1" },
          data: expect.objectContaining({ status: NotificationOutboxStatus.DISPATCHED }),
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
          payload: buildJobPayload("booking-2"),
        },
      ]);
      databaseServiceMock.notificationOutboxEvent.updateMany.mockResolvedValueOnce({ count: 1 });
      notificationServiceMock.enqueuePreparedNotification.mockResolvedValueOnce(undefined);

      const processed = await service.processPendingEvents();

      expect(processed).toBe(1);
      expect(databaseServiceMock.notificationOutboxEvent.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "evt-2",
            status: NotificationOutboxStatus.PROCESSING,
          }),
          data: { status: NotificationOutboxStatus.PROCESSING },
        }),
      );
    });

    it("marks an event FAILED when the queue enqueue throws", async () => {
      databaseServiceMock.notificationOutboxEvent.findMany.mockResolvedValueOnce([
        {
          id: "evt-3",
          bookingId: "booking-3",
          eventType: NotificationOutboxEventType.BOOKING_ASSIGNMENT,
          status: NotificationOutboxStatus.PENDING,
          attempts: 0,
          nextAttemptAt: new Date(Date.now() - 1000),
          payload: buildJobPayload("booking-3"),
        },
      ]);
      databaseServiceMock.notificationOutboxEvent.updateMany.mockResolvedValueOnce({ count: 1 });
      notificationServiceMock.enqueuePreparedNotification.mockRejectedValueOnce(
        new Error("Queue unavailable"),
      );

      const processed = await service.processPendingEvents();

      expect(processed).toBe(0);
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

    it("dead-letters a malformed payload that fails Zod parsing", async () => {
      databaseServiceMock.notificationOutboxEvent.findMany.mockResolvedValueOnce([
        {
          id: "evt-4",
          bookingId: "booking-4",
          eventType: NotificationOutboxEventType.BOOKING_ASSIGNMENT,
          status: NotificationOutboxStatus.PENDING,
          attempts: 0,
          nextAttemptAt: new Date(Date.now() - 1000),
          payload: {},
        },
      ]);
      databaseServiceMock.notificationOutboxEvent.updateMany.mockResolvedValueOnce({ count: 1 });

      const processed = await service.processPendingEvents();

      expect(processed).toBe(0);
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

    it("does not filter by eventType — handler-driven event types are auto-discovered", async () => {
      // A future event type, registered only by adding a handler. The
      // dispatcher must still pick it up without a code change here (Issue 2A).
      databaseServiceMock.notificationOutboxEvent.findMany.mockResolvedValueOnce([]);

      await service.processPendingEvents();

      expect(databaseServiceMock.notificationOutboxEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          // The findMany where-clause must NOT contain an eventType filter.
          where: expect.not.objectContaining({ eventType: expect.anything() }),
        }),
      );
    });
  });

  // Backoff schedule + DEAD_LETTER cutoff (Issue 10A). Pins the retry contract
  // so a typo in the exponent, the cap, or the maxAttempts threshold fails
  // visibly instead of silently changing user-visible delivery latency.
  describe("backoff schedule on enqueue failure", () => {
    const expectedBackoffSeconds: ReadonlyArray<readonly [attempt: number, seconds: number]> = [
      [1, 10],
      [2, 20],
      [3, 40],
      [4, 80],
      [5, 160],
      [6, 320],
      [7, 640],
      [8, 900], // 10 * 2^7 = 1280, capped at 15 * 60 = 900.
    ];

    const buildPendingEvent = (attempts: number) => ({
      id: `evt-attempt-${attempts}`,
      bookingId: `booking-attempt-${attempts}`,
      eventType: NotificationOutboxEventType.BOOKING_ASSIGNMENT,
      status: NotificationOutboxStatus.PENDING,
      attempts,
      nextAttemptAt: new Date(Date.now() - 1000),
      payload: {
        eventType: NotificationOutboxEventType.BOOKING_ASSIGNMENT,
        subtype: "CHAUFFEUR_ASSIGNED",
        notificationJobData: {
          id: `job-${attempts}`,
          type: "chauffeur-assigned",
          channels: ["email"],
          bookingId: `booking-attempt-${attempts}`,
          recipients: { client: { email: "x@example.com" } },
          templateData: {},
        },
      },
    });

    it.each(expectedBackoffSeconds)(
      "schedules attempt %i's next retry exactly %i seconds out",
      async (currentAttempt, expectedSeconds) => {
        const fixedNow = new Date("2026-05-09T20:00:00.000Z");
        vi.useFakeTimers();
        vi.setSystemTime(fixedNow);

        // event.attempts is the count BEFORE this run. After the claim
        // increments by 1, currentAttempt is event.attempts + 1.
        databaseServiceMock.notificationOutboxEvent.findMany.mockResolvedValueOnce([
          buildPendingEvent(currentAttempt - 1),
        ]);
        databaseServiceMock.notificationOutboxEvent.updateMany.mockResolvedValueOnce({ count: 1 });
        notificationServiceMock.enqueuePreparedNotification.mockRejectedValueOnce(
          new Error("BullMQ down"),
        );

        await service.processPendingEvents();

        const updateCall = vi
          .mocked(databaseServiceMock.notificationOutboxEvent.update)
          .mock.calls.at(-1);
        expect(updateCall).toBeDefined();
        const data = updateCall?.[0].data as { nextAttemptAt: Date };
        expect(data.nextAttemptAt.getTime() - fixedNow.getTime()).toBe(expectedSeconds * 1000);

        vi.useRealTimers();
      },
    );

    it("transitions to DEAD_LETTER (with processedAt) at attempt 8", async () => {
      databaseServiceMock.notificationOutboxEvent.findMany.mockResolvedValueOnce([
        buildPendingEvent(7), // currentAttempt becomes 8 after claim.
      ]);
      databaseServiceMock.notificationOutboxEvent.updateMany.mockResolvedValueOnce({ count: 1 });
      notificationServiceMock.enqueuePreparedNotification.mockRejectedValueOnce(
        new Error("Queue still down"),
      );

      await service.processPendingEvents();

      expect(databaseServiceMock.notificationOutboxEvent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "evt-attempt-7" },
          data: expect.objectContaining({
            status: NotificationOutboxStatus.DEAD_LETTER,
            processedAt: expect.any(Date),
          }),
        }),
      );
    });

    it("stays in FAILED (no processedAt) at attempt 7", async () => {
      databaseServiceMock.notificationOutboxEvent.findMany.mockResolvedValueOnce([
        buildPendingEvent(6), // currentAttempt becomes 7 after claim — under maxAttempts.
      ]);
      databaseServiceMock.notificationOutboxEvent.updateMany.mockResolvedValueOnce({ count: 1 });
      notificationServiceMock.enqueuePreparedNotification.mockRejectedValueOnce(
        new Error("Transient"),
      );

      await service.processPendingEvents();

      const updateCall = vi
        .mocked(databaseServiceMock.notificationOutboxEvent.update)
        .mock.calls.at(-1);
      const data = updateCall?.[0].data as {
        status: NotificationOutboxStatus;
        processedAt: Date | null;
      };
      expect(data.status).toBe(NotificationOutboxStatus.FAILED);
      expect(data.processedAt).toBeNull();
    });
  });

  // Concurrent-claim race (Issue 11A). Two scheduler instances pull the same
  // candidate row on overlapping ticks. The optimistic `updateMany` claim
  // must let exactly one win; the loser exits early without enqueueing.
  describe("concurrent claim contention", () => {
    it("enqueues exactly once when two pollers race for the same row", async () => {
      const candidate = {
        id: "evt-race",
        bookingId: "booking-race",
        eventType: NotificationOutboxEventType.BOOKING_ASSIGNMENT,
        status: NotificationOutboxStatus.PENDING,
        attempts: 0,
        nextAttemptAt: new Date(Date.now() - 1000),
        updatedAt: new Date(),
        payload: buildJobPayload("booking-race"),
      };

      // Both pollers see the same candidate.
      databaseServiceMock.notificationOutboxEvent.findMany
        .mockResolvedValueOnce([candidate])
        .mockResolvedValueOnce([candidate]);
      // Only the first claim wins.
      databaseServiceMock.notificationOutboxEvent.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });
      notificationServiceMock.enqueuePreparedNotification.mockResolvedValueOnce(undefined);

      const [first, second] = await Promise.all([
        service.processPendingEvents(),
        service.processPendingEvents(),
      ]);

      expect(first + second).toBe(1);
      expect(notificationServiceMock.enqueuePreparedNotification).toHaveBeenCalledTimes(1);
      // The losing poller must not finalise the row to DISPATCHED.
      expect(databaseServiceMock.notificationOutboxEvent.update).toHaveBeenCalledTimes(1);
      expect(databaseServiceMock.notificationOutboxEvent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "evt-race" },
          data: expect.objectContaining({ status: NotificationOutboxStatus.DISPATCHED }),
        }),
      );
    });
  });
});
