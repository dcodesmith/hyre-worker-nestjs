import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import {
  type DomainOutboxEvent,
  DomainOutboxEventType,
  DomainOutboxStatus,
  type Prisma,
} from "@prisma/client";
import type { Queue } from "bullmq";
import { PinoLogger } from "nestjs-pino";
import { DOMAIN_OUTBOX_QUEUE } from "../../config/constants";
import { DatabaseService } from "../database/database.service";
import type { DomainOutboxJobData } from "./domain-outbox.interface";

const MAX_ATTEMPTS = 8;
const PROCESSING_STALE_AFTER_MS = 2 * 60 * 1000;
const DISPATCH_STALE_AFTER_MS = 30 * 60 * 1000;
const JOB_ATTEMPTS = 3;
const JOB_BACKOFF_MS = 5000;
const DISPATCHED_JOB_RETENTION_SECONDS = 24 * 60 * 60;

export type DomainOutboxTransactionClient = {
  domainOutboxEvent: Pick<Prisma.TransactionClient["domainOutboxEvent"], "createMany">;
};

export type DomainOutboxEventInput = {
  eventType: DomainOutboxEventType;
  aggregateId: string;
};

type ProcessableDomainOutboxEvent = Pick<
  DomainOutboxEvent,
  "id" | "eventType" | "aggregateId" | "status" | "attempts" | "updatedAt"
>;

@Injectable()
export class DomainOutboxService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly logger: PinoLogger,
    @InjectQueue(DOMAIN_OUTBOX_QUEUE)
    private readonly domainOutboxQueue: Queue<DomainOutboxJobData>,
  ) {
    this.logger.setContext(DomainOutboxService.name);
  }

  async createMany(
    events: DomainOutboxEventInput[],
    tx: DomainOutboxTransactionClient,
  ): Promise<number> {
    if (events.length === 0) {
      return 0;
    }

    const created = await tx.domainOutboxEvent.createMany({
      data: events.map((event) => ({
        ...event,
        dedupeKey: `${event.eventType}:${event.aggregateId}`,
      })),
      skipDuplicates: true,
    });
    return created.count;
  }

  async processPendingEvents(limit = 25): Promise<number> {
    const now = new Date();
    const staleProcessingCutoff = new Date(now.getTime() - PROCESSING_STALE_AFTER_MS);
    const candidates = await this.databaseService.domainOutboxEvent.findMany({
      where: {
        OR: [
          {
            status: { in: [DomainOutboxStatus.PENDING, DomainOutboxStatus.FAILED] },
            nextAttemptAt: { lte: now },
          },
          {
            status: DomainOutboxStatus.PROCESSING,
            updatedAt: { lte: staleProcessingCutoff },
          },
          {
            status: DomainOutboxStatus.DISPATCHED,
            nextAttemptAt: { lte: now },
          },
        ],
      },
      orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
      take: limit,
    });

    if (candidates.length === limit) {
      this.logger.warn({ batchSize: limit }, "Domain outbox batch is saturated");
    }

    let processed = 0;
    for (const event of candidates) {
      try {
        processed += await this.processEvent(event, staleProcessingCutoff, now);
      } catch (error) {
        this.logger.error(
          {
            outboxEventId: event.id,
            aggregateId: event.aggregateId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to claim or process domain outbox event",
        );
      }
    }
    return processed;
  }

  private async processEvent(
    event: ProcessableDomainOutboxEvent,
    staleProcessingCutoff: Date,
    now: Date,
  ): Promise<number> {
    const claimWhere =
      event.status === DomainOutboxStatus.PROCESSING
        ? {
            id: event.id,
            status: DomainOutboxStatus.PROCESSING,
            updatedAt: { lte: staleProcessingCutoff },
          }
        : event.status === DomainOutboxStatus.DISPATCHED
          ? {
              id: event.id,
              status: DomainOutboxStatus.DISPATCHED,
              nextAttemptAt: { lte: now },
            }
          : {
              id: event.id,
              status: { in: [DomainOutboxStatus.PENDING, DomainOutboxStatus.FAILED] },
              nextAttemptAt: { lte: now },
            };
    const claimed = await this.databaseService.domainOutboxEvent.updateMany({
      where: claimWhere,
      data: {
        status: DomainOutboxStatus.PROCESSING,
        attempts: { increment: 1 },
      },
    });
    if (claimed.count === 0) {
      return 0;
    }

    const currentAttempt = event.attempts + 1;
    try {
      await this.dispatchEvent(event, currentAttempt);
      await this.databaseService.domainOutboxEvent.updateMany({
        where: {
          id: event.id,
          status: DomainOutboxStatus.PROCESSING,
        },
        data: {
          status: DomainOutboxStatus.DISPATCHED,
          nextAttemptAt: new Date(now.getTime() + DISPATCH_STALE_AFTER_MS),
          processedAt: null,
          lastError: null,
        },
      });
      return 1;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.markFailed(event.id, currentAttempt, errorMessage);

      this.logger.error(
        {
          outboxEventId: event.id,
          aggregateId: event.aggregateId,
          eventType: event.eventType,
          attempt: currentAttempt,
          error: errorMessage,
        },
        "Failed processing domain outbox event",
      );
      return 0;
    }
  }

  async resolveExecutableEvent(
    data: DomainOutboxJobData,
  ): Promise<ProcessableDomainOutboxEvent | null> {
    const event = await this.databaseService.domainOutboxEvent.findUnique({
      where: { id: data.outboxEventId },
      select: {
        id: true,
        eventType: true,
        aggregateId: true,
        status: true,
        attempts: true,
        updatedAt: true,
      },
    });

    if (
      !event ||
      event.eventType !== data.eventType ||
      event.aggregateId !== data.aggregateId ||
      event.attempts !== data.dispatchAttempt ||
      (event.status !== DomainOutboxStatus.DISPATCHED &&
        event.status !== DomainOutboxStatus.PROCESSING)
    ) {
      return null;
    }

    return event;
  }

  async markCompleted(outboxEventId: string, dispatchAttempt: number): Promise<void> {
    const { count } = await this.databaseService.domainOutboxEvent.updateMany({
      where: {
        id: outboxEventId,
        attempts: dispatchAttempt,
        status: {
          in: [DomainOutboxStatus.PROCESSING, DomainOutboxStatus.DISPATCHED],
        },
      },
      data: {
        status: DomainOutboxStatus.COMPLETED,
        processedAt: new Date(),
        lastError: null,
      },
    });

    if (count === 0) {
      this.logger.warn(
        { outboxEventId, dispatchAttempt },
        "Domain outbox event was not marked completed; row no longer matches dispatched attempt",
      );
    }
  }

  async markFailed(
    outboxEventId: string,
    dispatchAttempt: number,
    error: unknown,
    terminal = false,
  ): Promise<void> {
    const status =
      terminal || dispatchAttempt >= MAX_ATTEMPTS
        ? DomainOutboxStatus.DEAD_LETTER
        : DomainOutboxStatus.FAILED;
    const errorMessage = error instanceof Error ? error.message : String(error);

    await this.databaseService.domainOutboxEvent.updateMany({
      where: {
        id: outboxEventId,
        attempts: dispatchAttempt,
        status: {
          in: [DomainOutboxStatus.PROCESSING, DomainOutboxStatus.DISPATCHED],
        },
      },
      data: {
        status,
        nextAttemptAt: this.computeNextAttemptAt(dispatchAttempt),
        lastError: errorMessage.slice(0, 500),
        processedAt: status === DomainOutboxStatus.DEAD_LETTER ? new Date() : null,
      },
    });
  }

  private async dispatchEvent(
    event: ProcessableDomainOutboxEvent,
    dispatchAttempt: number,
  ): Promise<void> {
    await this.domainOutboxQueue.add(
      event.eventType,
      {
        outboxEventId: event.id,
        eventType: event.eventType,
        aggregateId: event.aggregateId,
        dispatchAttempt,
      },
      {
        jobId: `domain-outbox-${event.id}-${dispatchAttempt}`,
        attempts: JOB_ATTEMPTS,
        backoff: {
          type: "exponential",
          delay: JOB_BACKOFF_MS,
        },
        removeOnComplete: { age: DISPATCHED_JOB_RETENTION_SECONDS },
        removeOnFail: { age: DISPATCHED_JOB_RETENTION_SECONDS },
      },
    );
  }

  private computeNextAttemptAt(attempt: number): Date {
    const backoffSeconds = Math.min(10 * 2 ** Math.max(0, attempt - 1), 15 * 60);
    return new Date(Date.now() + backoffSeconds * 1000);
  }
}
