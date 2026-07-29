import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { DomainOutboxEventType, DomainOutboxStatus, PayoutTransactionStatus } from "@prisma/client";
import type { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { DOMAIN_OUTBOX_QUEUE } from "../src/config/constants";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import { DatabaseService } from "../src/modules/database/database.service";
import { DomainOutboxProcessor } from "../src/modules/domain-outbox/domain-outbox.processor";
import { DomainOutboxScheduler } from "../src/modules/domain-outbox/domain-outbox.scheduler";
import { DomainOutboxService } from "../src/modules/domain-outbox/domain-outbox.service";
import { StatusChangeService } from "../src/modules/status-change/status-change.service";
import { TestDataFactory, uniqueEmail } from "./helpers";

describe("Domain outbox round-trip (e2e)", () => {
  let app: INestApplication;
  let databaseService: DatabaseService;
  let domainOutboxProcessor: DomainOutboxProcessor;
  let domainOutboxService: DomainOutboxService;
  let statusChangeService: StatusChangeService;
  let domainOutboxQueue: Queue;
  let factory: TestDataFactory;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuthEmailService)
      .useValue({ sendOTPEmail: vi.fn().mockResolvedValue(undefined) })
      .overrideProvider(DomainOutboxScheduler)
      .useValue({ processDomainOutbox: vi.fn() })
      .compile();

    app = moduleFixture.createNestApplication({ logger: false });
    await app.init();

    databaseService = app.get(DatabaseService);
    domainOutboxProcessor = app.get(DomainOutboxProcessor);
    domainOutboxService = app.get(DomainOutboxService);
    statusChangeService = app.get(StatusChangeService);
    domainOutboxQueue = app.get(getQueueToken(DOMAIN_OUTBOX_QUEUE));
    factory = new TestDataFactory(databaseService, app);

    await domainOutboxQueue.pause();
  });

  afterAll(async () => {
    await domainOutboxQueue.drain(true);
    await domainOutboxQueue.resume();
    await app.close();
  });

  it("commits completion deliveries atomically and dispatches deterministic jobs", async () => {
    const customer = await factory.createUser({
      email: uniqueEmail("domain-outbox-customer"),
    });
    const fleetOwner = await factory.createFleetOwner({
      email: uniqueEmail("domain-outbox-owner"),
    });
    const car = await factory.createCar(fleetOwner.id, { status: "BOOKED" });
    const booking = await factory.createBooking(customer.id, car.id, {
      status: "ACTIVE",
      paymentStatus: "PAID",
      endDate: new Date(Date.now() - 60_000),
    });

    await statusChangeService.updateBookingsFromActiveToCompleted(
      new Date(Date.now() + 60_000).toISOString(),
    );

    const completedBooking = await databaseService.booking.findUniqueOrThrow({
      where: { id: booking.id },
      select: { status: true },
    });
    const deliveries = await databaseService.domainOutboxEvent.findMany({
      where: { aggregateId: booking.id },
      orderBy: { eventType: "asc" },
    });

    expect(completedBooking.status).toBe("COMPLETED");
    expect(deliveries).toHaveLength(2);
    expect(deliveries.map(({ eventType, status }) => ({ eventType, status }))).toEqual(
      expect.arrayContaining([
        {
          eventType: DomainOutboxEventType.PAYOUT_PROCESSING,
          status: DomainOutboxStatus.PENDING,
        },
        {
          eventType: DomainOutboxEventType.REFERRAL_COMPLETION,
          status: DomainOutboxStatus.PENDING,
        },
      ]),
    );

    expect(await domainOutboxService.processPendingEvents()).toBe(2);

    const dispatched = await databaseService.domainOutboxEvent.findMany({
      where: { aggregateId: booking.id },
    });
    expect(dispatched.every((event) => event.status === DomainOutboxStatus.DISPATCHED)).toBe(true);

    for (const event of dispatched) {
      expect(await domainOutboxQueue.getJob(`domain-outbox-${event.id}-1`)).not.toBeNull();
    }
  });

  it("retries one failed fan-out without repeating its successful sibling", async () => {
    const aggregateId = `partial-fanout-${Date.now()}`;
    await databaseService.$transaction((tx) =>
      domainOutboxService.createMany(
        [
          {
            eventType: DomainOutboxEventType.REFERRAL_COMPLETION,
            aggregateId,
          },
          {
            eventType: DomainOutboxEventType.PAYOUT_PROCESSING,
            aggregateId,
          },
        ],
        tx,
      ),
    );
    const originalAdd = domainOutboxQueue.add.bind(domainOutboxQueue);
    const payoutFailure = vi
      .spyOn(domainOutboxQueue, "add")
      .mockImplementation(async (name, data, options) => {
        if (name === DomainOutboxEventType.PAYOUT_PROCESSING) {
          throw new Error("Redis unavailable");
        }
        return originalAdd(name, data, options);
      });

    expect(await domainOutboxService.processPendingEvents()).toBe(1);

    const firstAttempt = await databaseService.domainOutboxEvent.findMany({
      where: { aggregateId },
    });
    expect(firstAttempt).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: DomainOutboxEventType.REFERRAL_COMPLETION,
          status: DomainOutboxStatus.DISPATCHED,
        }),
        expect.objectContaining({
          eventType: DomainOutboxEventType.PAYOUT_PROCESSING,
          status: DomainOutboxStatus.FAILED,
          attempts: 1,
          lastError: "Redis unavailable",
        }),
      ]),
    );

    payoutFailure.mockRestore();
    await databaseService.domainOutboxEvent.updateMany({
      where: {
        aggregateId,
        status: DomainOutboxStatus.FAILED,
      },
      data: { nextAttemptAt: new Date(0) },
    });

    expect(await domainOutboxService.processPendingEvents()).toBe(1);

    const finalDeliveries = await databaseService.domainOutboxEvent.findMany({
      where: { aggregateId },
    });
    expect(finalDeliveries.every((event) => event.status === DomainOutboxStatus.DISPATCHED)).toBe(
      true,
    );
    expect(
      finalDeliveries.find((event) => event.eventType === DomainOutboxEventType.REFERRAL_COMPLETION)
        ?.attempts,
    ).toBe(1);
  });

  it("marks a delivery completed only after its business handler succeeds", async () => {
    const aggregateId = `completed-command-${Date.now()}`;
    await databaseService.$transaction((tx) =>
      domainOutboxService.createMany(
        [{ eventType: DomainOutboxEventType.REFERRAL_COMPLETION, aggregateId }],
        tx,
      ),
    );

    expect(await domainOutboxService.processPendingEvents()).toBe(1);
    const dispatched = await databaseService.domainOutboxEvent.findUniqueOrThrow({
      where: { dedupeKey: `${DomainOutboxEventType.REFERRAL_COMPLETION}:${aggregateId}` },
    });
    expect(dispatched.status).toBe(DomainOutboxStatus.DISPATCHED);

    const job = await domainOutboxQueue.getJob(`domain-outbox-${dispatched.id}-1`);
    if (!job) {
      throw new Error("Expected domain outbox job to exist");
    }
    await domainOutboxProcessor.process(job);

    await expect(
      databaseService.domainOutboxEvent.findUniqueOrThrow({ where: { id: dispatched.id } }),
    ).resolves.toMatchObject({
      status: DomainOutboxStatus.COMPLETED,
      processedAt: expect.any(Date),
    });
  });

  it("enforces one payout transaction per booking", async () => {
    const customer = await factory.createUser({
      email: uniqueEmail("payout-idempotency-customer"),
    });
    const fleetOwner = await factory.createFleetOwner({
      email: uniqueEmail("payout-idempotency-owner"),
    });
    const car = await factory.createCar(fleetOwner.id);
    const booking = await factory.createBooking(customer.id, car.id);
    const payout = {
      fleetOwnerId: fleetOwner.id,
      bookingId: booking.id,
      amountToPay: 10_000,
      currency: "NGN",
      status: PayoutTransactionStatus.PENDING_DISBURSEMENT,
    };

    await databaseService.payoutTransaction.create({ data: payout });

    await expect(databaseService.payoutTransaction.create({ data: payout })).rejects.toMatchObject({
      code: "P2002",
    });
  });
});
