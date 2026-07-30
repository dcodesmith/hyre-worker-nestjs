import { getQueueToken } from "@nestjs/bullmq";
import { Test, type TestingModule } from "@nestjs/testing";
import { DomainOutboxEventType, DomainOutboxStatus } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { DOMAIN_OUTBOX_QUEUE } from "../../config/constants";
import { DatabaseService } from "../database/database.service";
import { DomainOutboxService } from "./domain-outbox.service";

describe("DomainOutboxService", () => {
  let service: DomainOutboxService;
  let logger: PinoLogger;
  const domainOutboxEvent = {
    createMany: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  };
  const domainOutboxQueue = {
    add: vi.fn(),
  };

  const pendingEvent = {
    id: "outbox-1",
    eventType: DomainOutboxEventType.REFERRAL_COMPLETION,
    status: DomainOutboxStatus.PENDING,
    aggregateId: "booking-1",
    dedupeKey: "REFERRAL_COMPLETION:booking-1",
    attempts: 0,
    nextAttemptAt: new Date("2030-01-02T12:00:00.000Z"),
    lastError: null,
    processedAt: null,
    createdAt: new Date("2030-01-02T12:00:00.000Z"),
    updatedAt: new Date("2030-01-02T12:00:00.000Z"),
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-02T12:05:00.000Z"));
    vi.clearAllMocks();
    domainOutboxEvent.createMany.mockResolvedValue({ count: 2 });
    domainOutboxEvent.findMany.mockResolvedValue([pendingEvent]);
    domainOutboxEvent.findUnique.mockResolvedValue(pendingEvent);
    domainOutboxEvent.updateMany.mockResolvedValue({ count: 1 });
    domainOutboxQueue.add.mockResolvedValue({ id: "job-1" });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DomainOutboxService,
        {
          provide: DatabaseService,
          useValue: { domainOutboxEvent },
        },
        {
          provide: getQueueToken(DOMAIN_OUTBOX_QUEUE),
          useValue: domainOutboxQueue,
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get(DomainOutboxService);
    logger = module.get(PinoLogger);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes typed deliveries with deterministic dedupe keys", async () => {
    const created = await service.createMany(
      [
        {
          eventType: DomainOutboxEventType.REFERRAL_COMPLETION,
          aggregateId: "booking-1",
        },
        {
          eventType: DomainOutboxEventType.PAYOUT_PROCESSING,
          aggregateId: "booking-1",
        },
      ],
      { domainOutboxEvent },
    );

    expect(domainOutboxEvent.createMany).toHaveBeenCalledWith({
      data: [
        {
          eventType: DomainOutboxEventType.REFERRAL_COMPLETION,
          aggregateId: "booking-1",
          dedupeKey: "REFERRAL_COMPLETION:booking-1",
        },
        {
          eventType: DomainOutboxEventType.PAYOUT_PROCESSING,
          aggregateId: "booking-1",
          dedupeKey: "PAYOUT_PROCESSING:booking-1",
        },
      ],
      skipDuplicates: true,
    });
    expect(created).toBe(2);
  });

  it("dispatches referral work with a retained attempt-specific job ID", async () => {
    expect(await service.processPendingEvents()).toBe(1);

    expect(domainOutboxQueue.add).toHaveBeenCalledWith(
      DomainOutboxEventType.REFERRAL_COMPLETION,
      {
        outboxEventId: "outbox-1",
        eventType: DomainOutboxEventType.REFERRAL_COMPLETION,
        aggregateId: "booking-1",
        dispatchAttempt: 1,
      },
      {
        jobId: "domain-outbox-outbox-1-1",
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { age: 86_400 },
        removeOnFail: { age: 86_400 },
      },
    );
    expect(domainOutboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: "outbox-1",
        status: DomainOutboxStatus.PROCESSING,
      },
      data: {
        status: DomainOutboxStatus.DISPATCHED,
        nextAttemptAt: new Date("2030-01-02T12:35:00.000Z"),
        processedAt: null,
        lastError: null,
      },
    });
  });

  it("dispatches payout work through the shared queue", async () => {
    domainOutboxEvent.findMany.mockResolvedValueOnce([
      {
        ...pendingEvent,
        eventType: DomainOutboxEventType.PAYOUT_PROCESSING,
      },
    ]);

    await service.processPendingEvents();

    expect(domainOutboxQueue.add).toHaveBeenCalledWith(
      DomainOutboxEventType.PAYOUT_PROCESSING,
      expect.objectContaining({
        eventType: DomainOutboxEventType.PAYOUT_PROCESSING,
        aggregateId: "booking-1",
      }),
      expect.any(Object),
    );
  });

  it("backs off a failed dispatch without blocking sibling events", async () => {
    const payoutEvent = {
      ...pendingEvent,
      id: "outbox-2",
      eventType: DomainOutboxEventType.PAYOUT_PROCESSING,
      dedupeKey: "PAYOUT_PROCESSING:booking-1",
    };
    domainOutboxEvent.findMany.mockResolvedValueOnce([pendingEvent, payoutEvent]);
    domainOutboxQueue.add.mockRejectedValueOnce(new Error("Redis unavailable"));

    expect(await service.processPendingEvents()).toBe(1);

    expect(domainOutboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: "outbox-1",
        attempts: 1,
        status: {
          in: [DomainOutboxStatus.PROCESSING, DomainOutboxStatus.DISPATCHED],
        },
      },
      data: {
        status: DomainOutboxStatus.FAILED,
        nextAttemptAt: new Date("2030-01-02T12:05:10.000Z"),
        lastError: "Redis unavailable",
        processedAt: null,
      },
    });
    expect(domainOutboxQueue.add).toHaveBeenCalledTimes(2);
  });

  it("dead-letters an event after the final attempt", async () => {
    domainOutboxEvent.findMany.mockResolvedValueOnce([{ ...pendingEvent, attempts: 7 }]);
    domainOutboxQueue.add.mockRejectedValueOnce(new Error("Persistent failure"));

    expect(await service.processPendingEvents()).toBe(0);

    expect(domainOutboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: "outbox-1",
        attempts: 8,
        status: {
          in: [DomainOutboxStatus.PROCESSING, DomainOutboxStatus.DISPATCHED],
        },
      },
      data: expect.objectContaining({
        status: DomainOutboxStatus.DEAD_LETTER,
        lastError: "Persistent failure",
        processedAt: new Date("2030-01-02T12:05:00.000Z"),
      }),
    });
  });

  it("dead-letters a terminal failure without exhausting dispatch attempts", async () => {
    await service.markFailed("outbox-1", 1, new Error("terminal failure"), true);

    expect(domainOutboxEvent.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        id: "outbox-1",
        attempts: 1,
        status: {
          in: [DomainOutboxStatus.PROCESSING, DomainOutboxStatus.DISPATCHED],
        },
      },
      data: {
        status: DomainOutboxStatus.DEAD_LETTER,
        nextAttemptAt: new Date("2030-01-02T12:05:10.000Z"),
        lastError: "terminal failure",
        processedAt: new Date("2030-01-02T12:05:00.000Z"),
      },
    });
  });

  it("reclaims stale processing events and counts the retry attempt", async () => {
    domainOutboxEvent.findMany.mockResolvedValueOnce([
      {
        ...pendingEvent,
        status: DomainOutboxStatus.PROCESSING,
        attempts: 2,
        updatedAt: new Date("2030-01-02T12:00:00.000Z"),
      },
    ]);

    await service.processPendingEvents();

    expect(domainOutboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: "outbox-1",
        status: DomainOutboxStatus.PROCESSING,
        updatedAt: { lte: new Date("2030-01-02T12:03:00.000Z") },
      },
      data: {
        status: DomainOutboxStatus.PROCESSING,
        attempts: { increment: 1 },
      },
    });
  });

  it("redrives dispatched events that never reached business completion", async () => {
    domainOutboxEvent.findMany.mockResolvedValueOnce([
      {
        ...pendingEvent,
        status: DomainOutboxStatus.DISPATCHED,
        attempts: 2,
        nextAttemptAt: new Date("2030-01-02T12:00:00.000Z"),
      },
    ]);

    await service.processPendingEvents();

    expect(domainOutboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: "outbox-1",
        status: DomainOutboxStatus.DISPATCHED,
        nextAttemptAt: { lte: new Date("2030-01-02T12:05:00.000Z") },
      },
      data: {
        status: DomainOutboxStatus.PROCESSING,
        attempts: { increment: 1 },
      },
    });
    expect(domainOutboxQueue.add).toHaveBeenCalledWith(
      DomainOutboxEventType.REFERRAL_COMPLETION,
      expect.objectContaining({ dispatchAttempt: 3 }),
      expect.objectContaining({ jobId: "domain-outbox-outbox-1-3" }),
    );
  });

  it("resolves an executable event bound to the dispatched attempt", async () => {
    domainOutboxEvent.findUnique.mockResolvedValueOnce({
      ...pendingEvent,
      status: DomainOutboxStatus.DISPATCHED,
      attempts: 1,
    });

    const event = await service.resolveExecutableEvent({
      outboxEventId: "outbox-1",
      eventType: DomainOutboxEventType.REFERRAL_COMPLETION,
      aggregateId: "booking-1",
      dispatchAttempt: 1,
    });

    expect(event).toMatchObject({ id: "outbox-1" });
  });

  it("rejects a job whose payload does not match the persisted event", async () => {
    domainOutboxEvent.findUnique.mockResolvedValueOnce({
      ...pendingEvent,
      status: DomainOutboxStatus.DISPATCHED,
      attempts: 2,
    });

    const event = await service.resolveExecutableEvent({
      outboxEventId: "outbox-1",
      eventType: DomainOutboxEventType.PAYOUT_PROCESSING,
      aggregateId: "booking-1",
      dispatchAttempt: 1,
    });

    expect(event).toBeNull();
  });

  it("marks successful business execution as completed for the dispatched attempt", async () => {
    await service.markCompleted("outbox-1", 1);

    expect(domainOutboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: "outbox-1",
        attempts: 1,
        status: {
          in: [DomainOutboxStatus.PROCESSING, DomainOutboxStatus.DISPATCHED],
        },
      },
      data: {
        status: DomainOutboxStatus.COMPLETED,
        processedAt: new Date("2030-01-02T12:05:00.000Z"),
        lastError: null,
      },
    });
  });

  it("warns when marking completed does not match a dispatched attempt", async () => {
    domainOutboxEvent.updateMany.mockResolvedValueOnce({ count: 0 });

    await service.markCompleted("outbox-1", 1);

    expect(logger.warn).toHaveBeenCalledWith(
      { outboxEventId: "outbox-1", dispatchAttempt: 1 },
      "Domain outbox event was not marked completed; row no longer matches dispatched attempt",
    );
  });

  it("does not let an older failed attempt overwrite newer or completed state", async () => {
    domainOutboxEvent.updateMany.mockResolvedValueOnce({ count: 0 });

    await service.markFailed("outbox-1", 1, new Error("late failure"));

    expect(domainOutboxEvent.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        id: "outbox-1",
        attempts: 1,
        status: {
          in: [DomainOutboxStatus.PROCESSING, DomainOutboxStatus.DISPATCHED],
        },
      },
      data: {
        status: DomainOutboxStatus.FAILED,
        nextAttemptAt: new Date("2030-01-02T12:05:10.000Z"),
        lastError: "late failure",
        processedAt: null,
      },
    });
  });

  it("does not dispatch when another worker wins the claim", async () => {
    domainOutboxEvent.updateMany.mockResolvedValueOnce({ count: 0 });

    expect(await service.processPendingEvents()).toBe(0);
    expect(domainOutboxQueue.add).not.toHaveBeenCalled();
  });

  it("warns when the selected batch is saturated", async () => {
    domainOutboxEvent.findMany.mockResolvedValueOnce([pendingEvent]);

    await service.processPendingEvents(1);

    expect(logger.warn).toHaveBeenCalledWith({ batchSize: 1 }, "Domain outbox batch is saturated");
  });
});
