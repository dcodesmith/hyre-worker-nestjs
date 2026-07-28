import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { NotificationOutboxEventType, NotificationOutboxStatus, type Prisma } from "@prisma/client";
import type { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { NOTIFICATIONS_QUEUE } from "../src/config/constants";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import { BookingConfirmationService } from "../src/modules/booking/booking-confirmation.service";
import { ExtensionConfirmationService } from "../src/modules/booking/extension-confirmation.service";
import { DatabaseService } from "../src/modules/database/database.service";
import { BookingConfirmedHandler } from "../src/modules/notification/handlers/booking-confirmed.handler";
import { BookingExtensionConfirmedHandler } from "../src/modules/notification/handlers/booking-extension-confirmed.handler";
import { BookingStatusChangedHandler } from "../src/modules/notification/handlers/booking-status-changed.handler";
import { NotificationOutboxService } from "../src/modules/notification/notification-outbox.service";
import { PaymentReconciliationService } from "../src/modules/payment/payment-reconciliation.service";
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
  let bookingConfirmedHandler: BookingConfirmedHandler;
  let bookingExtensionConfirmedHandler: BookingExtensionConfirmedHandler;
  let bookingConfirmationService: BookingConfirmationService;
  let extensionConfirmationService: ExtensionConfirmationService;
  let reconciliationService: PaymentReconciliationService;
  let notificationsQueue: Queue;
  let factory: TestDataFactory;

  async function createPendingExtensionPayment(label: string, confirmedAt: Date) {
    const customer = await factory.createUser({
      email: uniqueEmail(`${label}-customer`),
      name: "Extension Customer",
    });
    const fleetOwner = await factory.createFleetOwner();
    const car = await factory.createCar(fleetOwner.id);
    const booking = await factory.createBooking(customer.id, car.id, {
      status: "ACTIVE",
      paymentStatus: "PAID",
    });
    const legStartTime = new Date("2026-07-28T10:00:00.000Z");
    const originalLegEndTime = new Date("2026-07-28T12:00:00.000Z");
    const extendedLegEndTime = new Date("2026-07-28T13:00:00.000Z");
    const leg = await factory.createBookingLeg(booking.id, {
      legStartTime,
      legEndTime: originalLegEndTime,
    });
    const extension = await factory.createExtension(leg.id, {
      extensionStartTime: originalLegEndTime,
      extensionEndTime: extendedLegEndTime,
      totalAmount: 5000,
    });
    const payment = await databaseService.payment.create({
      data: {
        txRef: `extension-${label}-${Date.now()}`,
        extensionId: extension.id,
        amountExpected: 5000,
        amountCharged: 5000,
        currency: "NGN",
        status: "SUCCESSFUL",
        confirmedAt,
      },
    });

    return {
      customer,
      booking,
      leg,
      extension,
      payment,
      originalLegEndTime,
      extendedLegEndTime,
    };
  }

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
    bookingConfirmedHandler = app.get(BookingConfirmedHandler);
    bookingExtensionConfirmedHandler = app.get(BookingExtensionConfirmedHandler);
    bookingConfirmationService = app.get(BookingConfirmationService);
    extensionConfirmationService = app.get(ExtensionConfirmationService);
    reconciliationService = app.get(PaymentReconciliationService);
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
    expect(inboxRows[0].dedupeKey).toBe(outboxRow.dedupeKey);

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
      audience: "customer",
      recipients: {
        client: {
          userId: customer.id,
        },
      },
    });
    expect(job?.data.recipients.client).not.toHaveProperty("pushTokens");

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

  it("atomically confirms a booking and writes customer and owner outbox events", async () => {
    const customer = await factory.createUser({
      email: uniqueEmail("confirmation-outbox-customer"),
      name: "Confirmation Outbox Customer",
    });
    const fleetOwner = await factory.createFleetOwner();
    const car = await factory.createCar(fleetOwner.id);
    const booking = await factory.createBooking(customer.id, car.id);
    const paymentRecord = await factory.createPayment(booking.id, {
      amountExpected: 50000,
      amountCharged: 50000,
      status: "SUCCESSFUL",
      confirmedAt: new Date(Date.now() - 10 * 60 * 1000),
    });
    const payment = await databaseService.payment.findUniqueOrThrow({
      where: { id: paymentRecord.id },
    });

    await expect(bookingConfirmationService.confirmFromPayment(payment)).resolves.toBe(true);

    const confirmedBooking = await databaseService.booking.findUniqueOrThrow({
      where: { id: booking.id },
    });
    expect(confirmedBooking.status).toBe("CONFIRMED");
    expect(confirmedBooking.paymentStatus).toBe("PAID");

    const outboxRows = await databaseService.notificationOutboxEvent.findMany({
      where: { bookingId: booking.id },
      orderBy: { dedupeKey: "asc" },
    });
    expect(outboxRows).toHaveLength(2);
    expect(outboxRows.map((row) => row.dedupeKey)).toEqual([
      expect.stringMatching(/^booking-confirmed:.+:client:.+$/),
      expect.stringMatching(/^booking-confirmed:.+:fleet-owner:.+$/),
    ]);
    expect(outboxRows.every((row) => row.status === NotificationOutboxStatus.PENDING)).toBe(true);

    const inboxRows = await databaseService.notificationInbox.findMany({
      where: { userId: customer.id, payload: { path: ["bookingId"], equals: booking.id } },
    });
    expect(inboxRows).toHaveLength(1);
    expect(inboxRows[0].title).toBe("Booking confirmed");

    await expect(bookingConfirmationService.confirmFromPayment(payment)).resolves.toBe(false);
    await expect(
      databaseService.notificationOutboxEvent.count({ where: { bookingId: booking.id } }),
    ).resolves.toBe(2);

    for (let i = 0; i < 10; i++) {
      await outboxService.processPendingEvents();
      const pendingCount = await databaseService.notificationOutboxEvent.count({
        where: {
          id: { in: outboxRows.map((row) => row.id) },
          status: { not: NotificationOutboxStatus.DISPATCHED },
        },
      });
      if (pendingCount === 0) {
        break;
      }
    }

    for (const row of outboxRows) {
      const job = await notificationsQueue.getJob(`notification-outbox-${row.id}`);
      expect(job?.data.bookingId).toBe(booking.id);
      expect(["booking-confirmed", "fleet-owner-new-booking"]).toContain(job?.data.type);
    }
  });

  it("rolls back booking confirmation when its outbox event cannot be built", async () => {
    const customer = await factory.createUser({
      email: uniqueEmail("confirmation-rollback-customer"),
      name: "Confirmation Rollback Customer",
    });
    const fleetOwner = await factory.createFleetOwner();
    const car = await factory.createCar(fleetOwner.id);
    const booking = await factory.createBooking(customer.id, car.id);
    const paymentRecord = await factory.createPayment(booking.id, {
      amountExpected: 50000,
      amountCharged: 50000,
      status: "SUCCESSFUL",
      confirmedAt: new Date(),
    });
    const payment = await databaseService.payment.findUniqueOrThrow({
      where: { id: paymentRecord.id },
    });
    const buildEventsSpy = vi
      .spyOn(bookingConfirmedHandler, "buildEvents")
      .mockRejectedValueOnce(new Error("outbox build failed"));

    await expect(bookingConfirmationService.confirmFromPayment(payment)).rejects.toThrow(
      "outbox build failed",
    );
    buildEventsSpy.mockRestore();

    const unchangedBooking = await databaseService.booking.findUniqueOrThrow({
      where: { id: booking.id },
    });
    expect(unchangedBooking.status).toBe("PENDING");
    expect(unchangedBooking.paymentStatus).toBe("UNPAID");
    await expect(
      databaseService.notificationOutboxEvent.count({ where: { bookingId: booking.id } }),
    ).resolves.toBe(0);
  });

  it("recovers a stale successful payment whose booking remains pending", async () => {
    const customer = await factory.createUser({
      email: uniqueEmail("confirmation-reconcile-customer"),
      name: "Confirmation Reconcile Customer",
    });
    const fleetOwner = await factory.createFleetOwner();
    const car = await factory.createCar(fleetOwner.id);
    const booking = await factory.createBooking(customer.id, car.id);
    await factory.createPayment(booking.id, {
      amountExpected: 50000,
      amountCharged: 50000,
      status: "SUCCESSFUL",
      confirmedAt: new Date(Date.now() - 10 * 60 * 1000),
    });

    await expect(reconciliationService.reconcilePendingPayments()).resolves.toBeGreaterThanOrEqual(
      1,
    );

    const recoveredBooking = await databaseService.booking.findUniqueOrThrow({
      where: { id: booking.id },
    });
    expect(recoveredBooking.status).toBe("CONFIRMED");
    expect(recoveredBooking.paymentStatus).toBe("PAID");
    await expect(
      databaseService.notificationOutboxEvent.count({ where: { bookingId: booking.id } }),
    ).resolves.toBe(2);
  });

  it("atomically activates an extension and delivers its outbox event to BullMQ", async () => {
    const { customer, booking, leg, extension, payment, extendedLegEndTime } =
      await createPendingExtensionPayment(
        "extension-outbox",
        new Date(Date.now() - 10 * 60 * 1000),
      );

    await expect(extensionConfirmationService.confirmFromPayment(payment)).resolves.toBe(true);

    const activeExtension = await databaseService.extension.findUniqueOrThrow({
      where: { id: extension.id },
    });
    expect(activeExtension.status).toBe("ACTIVE");
    expect(activeExtension.paymentStatus).toBe("PAID");
    await expect(
      databaseService.bookingLeg.findUniqueOrThrow({ where: { id: leg.id } }),
    ).resolves.toMatchObject({ legEndTime: extendedLegEndTime });

    const outboxRows = await databaseService.notificationOutboxEvent.findMany({
      where: { bookingId: booking.id },
    });
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0].dedupeKey).toBe(`booking-extension-confirmed:${extension.id}:client`);

    const inboxRows = await databaseService.notificationInbox.findMany({
      where: { userId: customer.id, payload: { path: ["extensionId"], equals: extension.id } },
    });
    expect(inboxRows).toHaveLength(1);
    expect(inboxRows[0].title).toBe("Booking extension confirmed");

    await expect(extensionConfirmationService.confirmFromPayment(payment)).resolves.toBe(true);
    await expect(
      databaseService.notificationOutboxEvent.count({ where: { bookingId: booking.id } }),
    ).resolves.toBe(1);

    for (let i = 0; i < 10; i++) {
      await outboxService.processPendingEvents();
      const row = await databaseService.notificationOutboxEvent.findUniqueOrThrow({
        where: { id: outboxRows[0].id },
      });
      if (row.status === NotificationOutboxStatus.DISPATCHED) {
        break;
      }
    }

    const job = await notificationsQueue.getJob(`notification-outbox-${outboxRows[0].id}`);
    expect(job?.data).toMatchObject({
      bookingId: booking.id,
      type: "booking-extension-confirmed",
      audience: "customer",
      recipients: {
        client: {
          userId: customer.id,
        },
      },
    });
  });

  it("rolls back extension activation when its outbox event cannot be built", async () => {
    const { booking, leg, extension, payment, originalLegEndTime } =
      await createPendingExtensionPayment("extension-rollback", new Date());
    const buildEventsSpy = vi
      .spyOn(bookingExtensionConfirmedHandler, "buildEvents")
      .mockRejectedValueOnce(new Error("extension outbox build failed"));

    await expect(extensionConfirmationService.confirmFromPayment(payment)).rejects.toThrow(
      "extension outbox build failed",
    );
    buildEventsSpy.mockRestore();

    const unchangedExtension = await databaseService.extension.findUniqueOrThrow({
      where: { id: extension.id },
    });
    expect(unchangedExtension.status).toBe("PENDING");
    expect(unchangedExtension.paymentStatus).toBe("UNPAID");
    await expect(
      databaseService.bookingLeg.findUniqueOrThrow({ where: { id: leg.id } }),
    ).resolves.toMatchObject({ legEndTime: originalLegEndTime });
    await expect(
      databaseService.notificationOutboxEvent.count({ where: { bookingId: booking.id } }),
    ).resolves.toBe(0);
  });

  it("recovers a stale successful extension payment that remains pending", async () => {
    const { booking, extension } = await createPendingExtensionPayment(
      "extension-reconcile",
      new Date(Date.now() - 10 * 60 * 1000),
    );

    await expect(reconciliationService.reconcilePendingPayments()).resolves.toBeGreaterThanOrEqual(
      1,
    );

    const recoveredExtension = await databaseService.extension.findUniqueOrThrow({
      where: { id: extension.id },
    });
    expect(recoveredExtension.status).toBe("ACTIVE");
    expect(recoveredExtension.paymentStatus).toBe("PAID");
    await expect(
      databaseService.notificationOutboxEvent.count({ where: { bookingId: booking.id } }),
    ).resolves.toBe(1);
  });
});
