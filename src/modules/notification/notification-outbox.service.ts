import { Injectable } from "@nestjs/common";
import { NotificationOutboxStatus, Prisma } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import pLimit from "p-limit";
import { DatabaseService } from "../database/database.service";
import type { HandlerEvent, OutboxEventHandler } from "./handlers/outbox-event-handler.interface";
import { HIGH_PRIORITY_JOB_OPTIONS } from "./notification.const";
import { NotificationJobData } from "./notification.interface";
import { outboxPayloadSchema } from "./notification.schema";
import { NotificationService } from "./notification.service";

export type NotificationOutboxTransactionClient = {
  notificationInbox: Pick<Prisma.TransactionClient["notificationInbox"], "createMany">;
  notificationOutboxEvent: Pick<Prisma.TransactionClient["notificationOutboxEvent"], "createMany">;
};

/**
 * Single durability boundary for booking-lifecycle notifications.
 *
 * Domain services don't write notifications directly — they hand a typed
 * `OutboxEventHandler` and its input to `create()`, which fans out into one
 * notification-inbox row + one outbox row per `HandlerEvent`. The `processPendingEvents`
 * scheduler then drains the outbox into BullMQ.
 *
 * Adding a new notification event is purely additive: implement
 * `OutboxEventHandler<TInput>` in `./handlers/`, register it as a provider,
 * inject it where the domain change happens, and call `create(handler, input, tx)`.
 * No edits to this file are required (architectural review, Issue 1A + 2A).
 */
@Injectable()
export class NotificationOutboxService {
  private readonly maxAttempts = 8;
  private readonly processingStaleAfterMs = 2 * 60 * 1000;
  /**
   * Cap on concurrent in-flight `processEvent` calls per `processPendingEvents`
   * tick. Each event does 2–3 DB writes, so capping at 5 keeps peak connection
   * usage well below typical pool size while still draining bursts faster than
   * sequential processing.
   */
  private readonly processingConcurrency = 5;
  /**
   * Retain dispatched outbox-driven jobs in BullMQ for 24h so jobId-based
   * dedup keeps protecting us if a stale PROCESSING row is reclaimed and
   * we re-enqueue the same `notification-outbox-${eventId}` jobId.
   */
  private readonly dispatchedJobRetentionSeconds = 24 * 60 * 60;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly notificationService: NotificationService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(NotificationOutboxService.name);
  }

  /**
   * Run a handler for a domain change and persist its `HandlerEvent`s
   * (inbox row(s) + outbox row(s)) durably.
   *
   * - When `tx` is supplied, all writes participate in the caller's
   *   transaction. This is the right call for transactional domain mutations
   *   (status flip, cancellation, chauffeur assignment) — the booking change
   *   and the notification commit atomically.
   * - When `tx` is omitted, each handler-event is written in its own short
   *   transaction. Suitable for non-transactional fan-out (e.g. the reminder
   *   cron iterating across many legs).
   */
  async create<TInput>(
    handler: OutboxEventHandler<TInput>,
    input: TInput,
    tx?: NotificationOutboxTransactionClient,
  ): Promise<number> {
    const events = await handler.buildEvents(input);
    if (events.length === 0) {
      return 0;
    }

    if (tx) {
      for (const event of events) {
        await this.writeEvent(handler, event, tx);
      }
      return events.length;
    }

    for (const event of events) {
      await this.databaseService.$transaction(async (innerTx) => {
        await this.writeEvent(handler, event, innerTx);
      });
    }
    return events.length;
  }

  async processPendingEvents(limit = 25): Promise<number> {
    const now = new Date();
    const staleProcessingCutoff = new Date(now.getTime() - this.processingStaleAfterMs);
    // No eventType filter: the dispatcher is event-type-agnostic. New event
    // types added through new handlers are picked up automatically (Issue 2A).
    const candidates = await this.databaseService.notificationOutboxEvent.findMany({
      where: {
        OR: [
          {
            status: { in: [NotificationOutboxStatus.PENDING, NotificationOutboxStatus.FAILED] },
            nextAttemptAt: { lte: now },
          },
          {
            status: NotificationOutboxStatus.PROCESSING,
            updatedAt: { lte: staleProcessingCutoff },
          },
        ],
      },
      orderBy: { createdAt: "asc" },
      take: limit,
    });

    const concurrencyLimit = pLimit(this.processingConcurrency);
    // `Promise.allSettled` (not `Promise.all`) so a single sibling rejection
    // — e.g. a transient Prisma error inside `processEvent`'s claim, which
    // sits outside its inner try-catch — does not discard the resolved counts
    // of the other concurrent events nor short-circuit the scheduler's
    // multi-tick drain loop. Per-event rejections are logged here with the
    // owning `event.id`; happy-path infra errors thrown after the claim are
    // already handled inside `processEvent`'s try-catch.
    const results = await Promise.allSettled(
      candidates.map((event) =>
        concurrencyLimit(() => this.processEvent(event, staleProcessingCutoff, now)),
      ),
    );
    let processed = 0;
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") {
        processed += result.value;
        continue;
      }
      const reason = result.reason;
      this.logger.error(
        {
          outboxEventId: candidates[index]?.id,
          bookingId: candidates[index]?.bookingId,
          error: reason instanceof Error ? reason.message : String(reason),
        },
        "Failed to claim or process notification outbox event",
      );
    }
    return processed;
  }

  private async writeEvent<TInput>(
    handler: OutboxEventHandler<TInput>,
    event: HandlerEvent,
    writer: NotificationOutboxTransactionClient,
  ): Promise<void> {
    if (event.inbox) {
      // `skipDuplicates` + unique `dedupeKey`: inbox-only events (no jobData)
      // still dedupe on the cron path when the handler runs twice before the
      // domain anchor (e.g. leg `updatedAt`) moves — there is no outbox row to
      // provide Postgres uniqueness otherwise.
      await writer.notificationInbox.createMany({
        data: [
          {
            userId: event.inbox.userId,
            type: event.inbox.type,
            title: event.inbox.title,
            body: event.inbox.body,
            payload: this.toPrismaInputJsonValue(event.inbox.payload),
            dedupeKey: event.dedupeKey,
          },
        ],
        skipDuplicates: true,
      });
    }

    if (event.jobData) {
      // `createMany` + `skipDuplicates` mirrors the inbox path above. Without
      // it, a partial failure inside `create()`'s no-tx loop (event #1 commits,
      // event #2 fails) would surface as P2002 on the next cron tick when
      // event #1 is rewritten with the same `dedupeKey`, aborting the loop and
      // permanently stranding event #2 until the dedupe anchor moves.
      await writer.notificationOutboxEvent.createMany({
        data: [
          {
            userId: event.userId,
            eventType: handler.eventType,
            status: NotificationOutboxStatus.PENDING,
            dedupeKey: event.dedupeKey,
            bookingId: event.jobData.bookingId,
            payload: this.toPrismaInputJsonValue({
              eventType: handler.eventType,
              subtype: event.subtype,
              notificationJobData: event.jobData,
            }),
          },
        ],
        skipDuplicates: true,
      });
    }
  }

  private computeNextAttemptAt(attempt: number): Date {
    const backoffSeconds = Math.min(10 * 2 ** Math.max(0, attempt - 1), 15 * 60);
    return new Date(Date.now() + backoffSeconds * 1000);
  }

  private resolveFailureStatus(attempt: number): NotificationOutboxStatus {
    return attempt >= this.maxAttempts
      ? NotificationOutboxStatus.DEAD_LETTER
      : NotificationOutboxStatus.FAILED;
  }

  private async processEvent(
    event: {
      id: string;
      bookingId: string;
      status: NotificationOutboxStatus;
      attempts: number;
      payload: Prisma.JsonValue | null;
      updatedAt: Date;
    },
    staleProcessingCutoff: Date,
    now: Date,
  ): Promise<number> {
    const isStaleReclaim = event.status === NotificationOutboxStatus.PROCESSING;
    const claimed = isStaleReclaim
      ? await this.databaseService.notificationOutboxEvent.updateMany({
          where: {
            id: event.id,
            status: NotificationOutboxStatus.PROCESSING,
            updatedAt: { lte: staleProcessingCutoff },
          },
          data: {
            status: NotificationOutboxStatus.PROCESSING,
          },
        })
      : await this.databaseService.notificationOutboxEvent.updateMany({
          where: {
            id: event.id,
            status: { in: [NotificationOutboxStatus.PENDING, NotificationOutboxStatus.FAILED] },
            nextAttemptAt: { lte: now },
          },
          data: {
            status: NotificationOutboxStatus.PROCESSING,
            attempts: { increment: 1 },
          },
        });
    if (claimed.count === 0) {
      return 0;
    }

    const currentAttempt = isStaleReclaim ? event.attempts : event.attempts + 1;
    try {
      const notificationJobData = this.parseNotificationJobData(event.payload);
      if (!notificationJobData) {
        await this.databaseService.notificationOutboxEvent.update({
          where: { id: event.id },
          data: {
            status: NotificationOutboxStatus.DEAD_LETTER,
            lastError: "Invalid notification outbox payload",
            processedAt: new Date(),
          },
        });
        // Terminal scrub — not “progress toward dispatch”; count as 0 so the
        // scheduler does not burn re-ticks on rows already removed from work.
        return 0;
      }

      await this.notificationService.enqueuePreparedNotification(notificationJobData, {
        ...HIGH_PRIORITY_JOB_OPTIONS,
        jobId: `notification-outbox-${event.id}`,
        // Long retention so jobId-dedup keeps protecting us if a stale
        // PROCESSING outbox row is reclaimed and re-enqueued.
        removeOnComplete: { age: this.dispatchedJobRetentionSeconds },
        removeOnFail: { age: this.dispatchedJobRetentionSeconds },
      });

      await this.databaseService.notificationOutboxEvent.update({
        where: { id: event.id },
        data: {
          status: NotificationOutboxStatus.DISPATCHED,
          processedAt: new Date(),
          lastError: null,
        },
      });
      return 1;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const nextAttemptAt = this.computeNextAttemptAt(currentAttempt);

      await this.databaseService.notificationOutboxEvent.update({
        where: { id: event.id },
        data: {
          status: this.resolveFailureStatus(currentAttempt),
          nextAttemptAt,
          lastError: errorMessage.slice(0, 500),
          processedAt:
            this.resolveFailureStatus(currentAttempt) === NotificationOutboxStatus.DEAD_LETTER
              ? new Date()
              : null,
        },
      });

      this.logger.error(
        {
          outboxEventId: event.id,
          bookingId: event.bookingId,
          attempt: currentAttempt,
          error: errorMessage,
        },
        "Failed processing notification outbox event",
      );
      return 0;
    }
  }

  private parseNotificationJobData(payload: Prisma.JsonValue | null): NotificationJobData | null {
    if (!this.isPlainObject(payload)) {
      return null;
    }
    const parsed = outboxPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      return null;
    }
    return parsed.data.notificationJobData as unknown as NotificationJobData;
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private toPrismaInputJsonValue(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; // NOSONAR S7784 — JSON round-trip omits undefined & normalizes Dates for Prisma Json; structuredClone is wrong here
  }
}
