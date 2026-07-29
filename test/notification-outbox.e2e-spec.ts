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
import { BookingUpdateService } from "../src/modules/booking/booking-update.service";
import { ExtensionConfirmationService } from "../src/modules/booking/extension-confirmation.service";
import { DatabaseService } from "../src/modules/database/database.service";
import { BookingConfirmedHandler } from "../src/modules/notification/handlers/booking-confirmed.handler";
import { BookingExtensionConfirmedHandler } from "../src/modules/notification/handlers/booking-extension-confirmed.handler";
import { BookingStatusChangedHandler } from "../src/modules/notification/handlers/booking-status-changed.handler";
import { BookingUpdatedHandler } from "../src/modules/notification/handlers/booking-updated.handler";
import { ReferralRewardReleasedHandler } from "../src/modules/notification/handlers/referral-reward-released.handler";
import { ReviewReceivedHandler } from "../src/modules/notification/handlers/review-received.handler";
import { NotificationOutboxService } from "../src/modules/notification/notification-outbox.service";
import { PaymentReconciliationService } from "../src/modules/payment/payment-reconciliation.service";
import { ReferralProcessingService } from "../src/modules/referral/referral-processing.service";
import { ReviewsWriteService } from "../src/modules/reviews/reviews-write.service";
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
  let bookingUpdatedHandler: BookingUpdatedHandler;
  let referralRewardReleasedHandler: ReferralRewardReleasedHandler;
  let reviewReceivedHandler: ReviewReceivedHandler;
  let bookingConfirmationService: BookingConfirmationService;
  let bookingUpdateService: BookingUpdateService;
  let extensionConfirmationService: ExtensionConfirmationService;
  let reconciliationService: PaymentReconciliationService;
  let referralProcessingService: ReferralProcessingService;
  let reviewsWriteService: ReviewsWriteService;
  let notificationsQueue: Queue;
  let factory: TestDataFactory;

  async function dispatchOutboxEvents(ids: string[]): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt++) {
      await outboxService.processPendingEvents();
      const pendingCount = await databaseService.notificationOutboxEvent.count({
        where: {
          id: { in: ids },
          status: { not: NotificationOutboxStatus.DISPATCHED },
        },
      });
      if (pendingCount === 0) {
        return;
      }
    }
    throw new Error(`Outbox events were not dispatched: ${ids.join(", ")}`);
  }

  async function createReviewBooking(label: string) {
    const customer = await factory.createUser({
      email: uniqueEmail(`${label}-customer`),
      name: "Review Customer",
    });
    const fleetOwner = await factory.createFleetOwner({
      email: uniqueEmail(`${label}-owner`),
      name: "Review Owner",
    });
    const chauffeur = await factory.createChauffeur({
      email: uniqueEmail(`${label}-chauffeur`),
      name: "Review Chauffeur",
    });
    const car = await factory.createCar(fleetOwner.id);
    const booking = await factory.createBooking(customer.id, car.id, {
      status: "COMPLETED",
      chauffeurId: chauffeur.id,
      endDate: new Date(),
    });

    return { customer, fleetOwner, chauffeur, booking };
  }

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

  async function configureCompletedReferralRelease(): Promise<void> {
    await Promise.all([
      databaseService.referralProgramConfig.upsert({
        where: { key: "REFERRAL_ENABLED" },
        create: { key: "REFERRAL_ENABLED", value: true },
        update: { value: true },
      }),
      databaseService.referralProgramConfig.upsert({
        where: { key: "REFERRAL_RELEASE_CONDITION" },
        create: { key: "REFERRAL_RELEASE_CONDITION", value: "COMPLETED" },
        update: { value: "COMPLETED" },
      }),
      databaseService.referralProgramConfig.upsert({
        where: { key: "REFERRAL_EXPIRY_DAYS" },
        create: { key: "REFERRAL_EXPIRY_DAYS", value: 0 },
        update: { value: 0 },
      }),
    ]);
  }

  async function createCompletedReferralReward(label: string) {
    const referrer = await factory.createUser({
      email: uniqueEmail(`${label}-referrer`),
    });
    const referee = await factory.createUser({
      email: uniqueEmail(`${label}-referee`),
    });
    const fleetOwner = await factory.createFleetOwner();
    const car = await factory.createCar(fleetOwner.id);
    const booking = await factory.createBooking(referee.id, car.id, {
      status: "COMPLETED",
      paymentStatus: "PAID",
    });
    await databaseService.booking.update({
      where: { id: booking.id },
      data: {
        referralReferrerUserId: referrer.id,
        referralStatus: "APPLIED",
        referralDiscountAmount: 5000,
      },
    });
    const reward = await databaseService.referralReward.create({
      data: {
        referrerUserId: referrer.id,
        refereeUserId: referee.id,
        bookingId: booking.id,
        amount: 2500,
        status: "PENDING",
        releaseCondition: "COMPLETED",
      },
    });
    await databaseService.userReferralStats.create({
      data: {
        userId: referrer.id,
        totalReferrals: 1,
        totalRewardsGranted: 0,
        totalRewardsPending: 2500,
      },
    });
    await configureCompletedReferralRelease();

    return { booking, referrer, reward };
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
    bookingUpdatedHandler = app.get(BookingUpdatedHandler);
    referralRewardReleasedHandler = app.get(ReferralRewardReleasedHandler);
    reviewReceivedHandler = app.get(ReviewReceivedHandler);
    bookingConfirmationService = app.get(BookingConfirmationService);
    bookingUpdateService = app.get(BookingUpdateService);
    extensionConfirmationService = app.get(ExtensionConfirmationService);
    reconciliationService = app.get(PaymentReconciliationService);
    referralProcessingService = app.get(ReferralProcessingService);
    reviewsWriteService = app.get(ReviewsWriteService);
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

    // Step 3 — invoke the dispatcher directly instead of waiting for the cron.
    // Do not assert on processPendingEvents()'s return value: Vitest pools share
    // one `e2e_w{n}` Postgres schema per worker; a tick may process zero rows
    // (claim races) or unrelated rows. We only care that our row is dispatched.
    await dispatchOutboxEvents([outboxRow.id]);

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

  it("queues a typed booking target without PUSH when the customer updates their own booking", async () => {
    const customer = await factory.createUser({
      email: uniqueEmail("booking-update-customer"),
      name: "Booking Update Customer",
    });
    await databaseService.user.update({
      where: { id: customer.id },
      data: { phoneNumber: "+2348012345678" },
    });
    const fleetOwner = await factory.createFleetOwner();
    const car = await factory.createCar(fleetOwner.id);
    const booking = await factory.createBooking(customer.id, car.id, {
      status: "CONFIRMED",
      paymentStatus: "PAID",
      startDate: new Date(Date.now() + 48 * 60 * 60 * 1000),
      endDate: new Date(Date.now() + 60 * 60 * 60 * 1000),
    });

    await bookingUpdateService.updateBooking(booking.id, customer.id, {
      pickupAddress: "Updated Pickup Address",
    });

    const outboxRow = await databaseService.notificationOutboxEvent.findFirstOrThrow({
      where: {
        bookingId: booking.id,
        dedupeKey: { startsWith: `booking-updated:${booking.id}:` },
      },
    });
    expect(outboxRow.status).toBe(NotificationOutboxStatus.PENDING);

    const inboxRow = await databaseService.notificationInbox.findFirstOrThrow({
      where: {
        userId: customer.id,
        dedupeKey: outboxRow.dedupeKey,
      },
    });
    expect(inboxRow.title).toBe("Booking updated");

    await dispatchOutboxEvents([outboxRow.id]);

    const job = await notificationsQueue.getJob(`notification-outbox-${outboxRow.id}`);
    expect(job?.data).toMatchObject({
      type: "booking-updated",
      bookingId: booking.id,
      channels: ["email", "whatsapp"],
      recipients: {
        client: {
          phoneNumber: "+2348012345678",
        },
      },
      pushPayload: {
        data: {
          type: "booking-updated",
          target: {
            kind: "booking",
            bookingId: booking.id,
          },
        },
      },
    });
    expect(job?.data.channels).not.toContain("push");
  });

  it("rolls back a booking update when its durable notification cannot be built", async () => {
    const customer = await factory.createUser({
      email: uniqueEmail("booking-update-rollback-customer"),
      name: "Booking Update Rollback Customer",
    });
    const fleetOwner = await factory.createFleetOwner();
    const car = await factory.createCar(fleetOwner.id);
    const booking = await factory.createBooking(customer.id, car.id, {
      status: "CONFIRMED",
      paymentStatus: "PAID",
      pickupLocation: "Original Pickup Address",
      startDate: new Date(Date.now() + 48 * 60 * 60 * 1000),
      endDate: new Date(Date.now() + 60 * 60 * 60 * 1000),
    });
    const buildEventsSpy = vi
      .spyOn(bookingUpdatedHandler, "buildEvents")
      .mockRejectedValueOnce(new Error("outbox build failed"));

    await expect(
      bookingUpdateService.updateBooking(booking.id, customer.id, {
        pickupAddress: "Should Roll Back",
      }),
    ).rejects.toThrow();
    buildEventsSpy.mockRestore();

    const unchangedBooking = await databaseService.booking.findUniqueOrThrow({
      where: { id: booking.id },
    });
    expect(unchangedBooking.pickupLocation).toBe("Original Pickup Address");
    await expect(
      databaseService.notificationOutboxEvent.count({ where: { bookingId: booking.id } }),
    ).resolves.toBe(0);
    await expect(
      databaseService.notificationInbox.count({ where: { userId: customer.id } }),
    ).resolves.toBe(0);
  });

  it("atomically creates a review and delivers owner and chauffeur emails through the outbox", async () => {
    const { customer, fleetOwner, chauffeur, booking } = await createReviewBooking("review-outbox");

    const review = await reviewsWriteService.createReview(customer.id, {
      bookingId: booking.id,
      overallRating: 5,
      carRating: 5,
      chauffeurRating: 4,
      serviceRating: 5,
      comment: "Excellent trip",
    });

    const outboxRows = await databaseService.notificationOutboxEvent.findMany({
      where: { bookingId: booking.id },
      orderBy: { dedupeKey: "asc" },
    });
    expect(outboxRows).toHaveLength(2);
    expect(outboxRows.map((row) => row.dedupeKey)).toEqual([
      `review-received:${review.id}:chauffeur`,
      `review-received:${review.id}:fleet-owner`,
    ]);
    expect(outboxRows.map((row) => row.userId)).toEqual(
      expect.arrayContaining([chauffeur.id, fleetOwner.id]),
    );
    expect(
      outboxRows.every(
        (row) =>
          row.eventType === NotificationOutboxEventType.BOOKING_LIFECYCLE &&
          row.status === NotificationOutboxStatus.PENDING,
      ),
    ).toBe(true);

    await dispatchOutboxEvents(outboxRows.map((row) => row.id));

    const jobs = await Promise.all(
      outboxRows.map((row) => notificationsQueue.getJob(`notification-outbox-${row.id}`)),
    );
    expect(jobs.map((job) => job?.data)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `review-received-owner-${review.id}`,
          type: "review-received",
          audience: "fleet-owner",
          channels: ["email"],
          bookingId: booking.id,
          recipients: {
            fleetOwner: {
              userId: fleetOwner.id,
              email: fleetOwner.email,
            },
          },
        }),
        expect.objectContaining({
          id: `review-received-chauffeur-${review.id}`,
          type: "review-received",
          audience: "chauffeur",
          channels: ["email"],
          bookingId: booking.id,
          recipients: {
            chauffeur: {
              userId: chauffeur.id,
              email: chauffeur.email,
            },
          },
        }),
      ]),
    );
  });

  it("rolls back review creation when its durable notifications cannot be built", async () => {
    const { customer, booking } = await createReviewBooking("review-rollback");
    const buildEventsSpy = vi
      .spyOn(reviewReceivedHandler, "buildEvents")
      .mockRejectedValueOnce(new Error("review outbox build failed"));

    await expect(
      reviewsWriteService.createReview(customer.id, {
        bookingId: booking.id,
        overallRating: 5,
        carRating: 5,
        chauffeurRating: 5,
        serviceRating: 5,
      }),
    ).rejects.toThrow("review outbox build failed");
    buildEventsSpy.mockRestore();

    await expect(databaseService.review.count({ where: { bookingId: booking.id } })).resolves.toBe(
      0,
    );
    await expect(
      databaseService.notificationOutboxEvent.count({ where: { bookingId: booking.id } }),
    ).resolves.toBe(0);
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

    await dispatchOutboxEvents(outboxRows.map((row) => row.id));

    for (const row of outboxRows) {
      const job = await notificationsQueue.getJob(`notification-outbox-${row.id}`);
      expect(job?.data.bookingId).toBe(booking.id);
      expect(["booking-confirmed", "fleet-owner-new-booking"]).toContain(job?.data.type);
      if (row.dedupeKey.includes(":client:")) {
        expect(job?.data.pushPayload?.data).toEqual({
          type: "booking-confirmed",
          target: {
            kind: "booking",
            bookingId: booking.id,
          },
        });
      }
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

    await dispatchOutboxEvents([outboxRows[0].id]);

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

  it("releases a completed referral reward once and dispatches its typed referrals push", async () => {
    const { booking, referrer, reward } = await createCompletedReferralReward("referral-reward");

    await referralProcessingService.processReferralCompletionForBooking(booking.id);
    await referralProcessingService.processReferralCompletionForBooking(booking.id);

    await expect(
      databaseService.referralReward.findUniqueOrThrow({ where: { id: reward.id } }),
    ).resolves.toMatchObject({ status: "RELEASED", processedAt: expect.any(Date) });
    await expect(
      databaseService.booking.findUniqueOrThrow({ where: { id: booking.id } }),
    ).resolves.toMatchObject({ referralStatus: "REWARDED" });
    const stats = await databaseService.userReferralStats.findUniqueOrThrow({
      where: { userId: referrer.id },
    });
    expect(stats.totalReferrals).toBe(1);
    expect(stats.totalRewardsGranted.toString()).toBe("2500");
    expect(stats.totalRewardsPending.toString()).toBe("0");

    const outboxRows = await databaseService.notificationOutboxEvent.findMany({
      where: {
        bookingId: booking.id,
        dedupeKey: { startsWith: `referral-reward-released:${reward.id}:` },
      },
    });
    expect(outboxRows).toHaveLength(1);
    const inboxRows = await databaseService.notificationInbox.findMany({
      where: { userId: referrer.id, dedupeKey: outboxRows[0].dedupeKey },
    });
    expect(inboxRows).toHaveLength(1);
    expect(inboxRows[0]).toMatchObject({
      title: "Referral reward earned",
      body: "₦2,500.00 has been added to your referral balance.",
    });

    await dispatchOutboxEvents([outboxRows[0].id]);

    const job = await notificationsQueue.getJob(`notification-outbox-${outboxRows[0].id}`);
    expect(job?.data).toMatchObject({
      type: "referral-reward-released",
      audience: "customer",
      channels: ["push"],
      bookingId: booking.id,
      recipients: {
        client: {
          userId: referrer.id,
        },
      },
      pushPayload: {
        data: {
          type: "referral-reward-released",
          target: { kind: "referrals" },
        },
      },
    });
  });

  it("rolls back a reward release when its durable notification cannot be built", async () => {
    const { booking, referrer, reward } = await createCompletedReferralReward("referral-rollback");
    const buildEventsSpy = vi
      .spyOn(referralRewardReleasedHandler, "buildEvents")
      .mockRejectedValueOnce(new Error("referral outbox build failed"));

    await expect(
      referralProcessingService.processReferralCompletionForBooking(booking.id),
    ).rejects.toThrow("referral outbox build failed");
    buildEventsSpy.mockRestore();

    await expect(
      databaseService.referralReward.findUniqueOrThrow({ where: { id: reward.id } }),
    ).resolves.toMatchObject({ status: "PENDING", processedAt: null });
    await expect(
      databaseService.booking.findUniqueOrThrow({ where: { id: booking.id } }),
    ).resolves.toMatchObject({ referralStatus: "APPLIED" });
    const stats = await databaseService.userReferralStats.findUniqueOrThrow({
      where: { userId: referrer.id },
    });
    expect(stats.totalRewardsGranted.toString()).toBe("0");
    expect(stats.totalRewardsPending.toString()).toBe("2500");
    await expect(
      databaseService.notificationOutboxEvent.count({ where: { bookingId: booking.id } }),
    ).resolves.toBe(0);
    await expect(
      databaseService.notificationInbox.count({ where: { userId: referrer.id } }),
    ).resolves.toBe(0);
  });
});
