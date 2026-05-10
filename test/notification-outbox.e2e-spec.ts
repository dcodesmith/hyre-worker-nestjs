import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { NotificationOutboxEventType, NotificationOutboxStatus, type Prisma } from "@prisma/client";
import type { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { NOTIFICATIONS_QUEUE } from "../src/config/constants";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import { DatabaseService } from "../src/modules/database/database.service";
import { BookingStatusChangedHandler } from "../src/modules/notification/handlers/booking-status-changed.handler";
import { NotificationOutboxService } from "../src/modules/notification/notification-outbox.service";
import { TestDataFactory, uniqueEmail } from "./helpers";

/**
 * Outbox round-trip e2e (Issue 9A). Exercises the boundary that every unit
 * spec stops short of: domain-tx -> outbox row -> dispatcher claim -> BullMQ
 * enqueue -> DISPATCHED finalisation. If Prisma transaction semantics, the
 * BullMQ jobId-dedup contract, or the optimistic-claim filter ever break
 * subtly, this test fails — the unit specs would not.
 */
describe("Notification outbox round-trip (e2e)", () => {
  let app: INestApplication;
  let databaseService: DatabaseService;
  let outboxService: NotificationOutboxService;
  let statusChangedHandler: BookingStatusChangedHandler;
  let notificationsQueue: Queue;
  let factory: TestDataFactory;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuthEmailService)
      .useValue({ sendOTPEmail: vi.fn().mockResolvedValue(undefined) })
      .compile();

    app = moduleFixture.createNestApplication({ logger: false });

    databaseService = app.get(DatabaseService);
    outboxService = app.get(NotificationOutboxService);
    statusChangedHandler = app.get(BookingStatusChangedHandler);
    notificationsQueue = app.get(getQueueToken(NOTIFICATIONS_QUEUE));
    factory = new TestDataFactory(databaseService, app);

    await app.init();
  });

  afterAll(async () => {
    // Close the Nest app first so BullMQ workers/processors shut down before we
    // wipe Redis queue keys — obliterate while workers are active can race and
    // surface BullMQ "Missing key" errors.
    await app.close();
    await notificationsQueue.obliterate({ force: true }).catch(() => {});
  });

  it("writes inbox + outbox in the domain tx, then drains via processPendingEvents to DISPATCHED + a BullMQ job", async () => {
    const customer = await factory.createUser({
      email: uniqueEmail("outbox-customer"),
      name: "Outbox Customer",
    });
    const fleetOwner = await factory.createFleetOwner();
    const car = await factory.createCar(fleetOwner.id);
    const booking = await factory.createBooking(customer.id, car.id, {
      status: "CONFIRMED",
      paymentStatus: "PAID",
    });

    // Refetch with all relations the handler/normaliser need.
    const bookingWithRelations = await databaseService.booking.findUniqueOrThrow({
      where: { id: booking.id },
      include: {
        user: true,
        chauffeur: true,
        car: { include: { owner: true } },
      },
    });

    // Step 1 — domain transaction commits the booking change AND the outbox
    // event atomically. This is the contract callers must follow.
    let writtenCount = 0;
    await databaseService.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.booking.update({
        where: { id: booking.id },
        data: { status: "ACTIVE" },
      });
      writtenCount = await outboxService.create(
        statusChangedHandler,
        {
          booking: bookingWithRelations,
          oldStatus: "CONFIRMED",
          newStatus: "ACTIVE",
        },
        tx,
      );
    });
    expect(writtenCount).toBe(1);

    // Step 2 — both rows landed in the same tx as the booking flip.
    const pendingOutboxRows = await databaseService.notificationOutboxEvent.findMany({
      where: { bookingId: booking.id },
    });
    expect(pendingOutboxRows).toHaveLength(1);
    const outboxRow = pendingOutboxRows[0];
    expect(outboxRow.eventType).toBe(NotificationOutboxEventType.BOOKING_LIFECYCLE);
    expect(outboxRow.status).toBe(NotificationOutboxStatus.PENDING);
    expect(outboxRow.userId).toBe(customer.id);
    expect(outboxRow.dedupeKey).toMatch(/^booking-status:.+:CONFIRMED:ACTIVE:.+$/);

    const inboxRows = await databaseService.notificationInbox.findMany({
      where: { userId: customer.id, type: "BOOKING_LIFECYCLE" },
    });
    expect(inboxRows).toHaveLength(1);
    expect(inboxRows[0].title).toBe("Booking status updated");

    // Step 3 — the dispatcher loop runs. We invoke directly instead of waiting
    // for the cron so the test stays deterministic.
    //
    // Do not assert on processPendingEvents()'s return value: Vitest pools share
    // one `e2e_w{n}` Postgres schema per worker; a tick may process zero rows
    // (claim races) or many unrelated rows. We only care that this test's row
    // reaches DISPATCHED (Step 4 + drain loop below).
    await outboxService.processPendingEvents();

    // Our row may not have been in the first batch if many older rows exist —
    // keep draining until this test's row is DISPATCHED (cap iterations).
    for (let i = 0; i < 10; i++) {
      const row = await databaseService.notificationOutboxEvent.findUnique({
        where: { id: outboxRow.id },
      });
      if (row?.status === NotificationOutboxStatus.DISPATCHED) {
        break;
      }
      await outboxService.processPendingEvents();
    }

    // Step 4 — the row finalised to DISPATCHED with processedAt set, no error.
    const finalRow = await databaseService.notificationOutboxEvent.findUniqueOrThrow({
      where: { id: outboxRow.id },
    });
    expect(finalRow.status).toBe(NotificationOutboxStatus.DISPATCHED);
    expect(finalRow.processedAt).not.toBeNull();
    expect(finalRow.lastError).toBeNull();

    // Step 5 — BullMQ has a job with the deterministic jobId-dedup token.
    const job = await notificationsQueue.getJob(`notification-outbox-${outboxRow.id}`);
    expect(job).toBeDefined();
    expect(job?.data).toMatchObject({
      bookingId: booking.id,
      type: "booking-status-change",
    });

    // Step 6 — our DISPATCHED row must not be re-claimed when the dispatcher
    // runs again. Global `reprocessed` may be > 0 if other suites added rows.
    const processedAtSnapshot = finalRow.processedAt;
    await outboxService.processPendingEvents();
    const still = await databaseService.notificationOutboxEvent.findUniqueOrThrow({
      where: { id: outboxRow.id },
    });
    expect(still.status).toBe(NotificationOutboxStatus.DISPATCHED);
    expect(still.processedAt?.toISOString()).toBe(processedAtSnapshot?.toISOString());
  });
});
