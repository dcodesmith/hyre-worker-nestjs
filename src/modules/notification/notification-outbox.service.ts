import { Injectable } from "@nestjs/common";
import {
  NotificationInboxType,
  NotificationOutboxEventType,
  NotificationOutboxStatus,
  Prisma,
} from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import type { BookingWithRelations } from "../../types";
import { DatabaseService } from "../database/database.service";
import { HIGH_PRIORITY_JOB_OPTIONS } from "./notification.const";
import { NotificationJobData } from "./notification.interface";
import { NotificationService } from "./notification.service";

export type NotificationOutboxTransactionClient = {
  notificationInbox: Pick<Prisma.TransactionClient["notificationInbox"], "create">;
  notificationOutboxEvent: Pick<Prisma.TransactionClient["notificationOutboxEvent"], "create">;
  userPushToken: Pick<Prisma.TransactionClient["userPushToken"], "findMany">;
};

@Injectable()
export class NotificationOutboxService {
  private readonly maxAttempts = 8;
  private readonly processingStaleAfterMs = 2 * 60 * 1000;
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

  async createChauffeurAssignedEvent(
    tx: NotificationOutboxTransactionClient,
    booking: BookingWithRelations,
    chauffeurId: string,
  ): Promise<void> {
    const dedupeKey = `chauffeur-assigned:${booking.id}:${chauffeurId}:${booking.updatedAt.toISOString()}`;
    const inboxPayload = {
      bookingId: booking.id,
      chauffeurId,
    } as const;
    const pushTokens = booking.userId
      ? (
          await tx.userPushToken.findMany({
            where: {
              userId: booking.userId,
              revokedAt: null,
            },
            select: {
              token: true,
            },
          })
        ).map((record) => record.token)
      : [];
    const notificationJobData = await this.notificationService.buildChauffeurAssignedJobData(
      booking,
      {
        pushTokens,
      },
    );

    if (booking.userId) {
      await tx.notificationInbox.create({
        data: {
          userId: booking.userId,
          type: NotificationInboxType.CHAUFFEUR_ASSIGNED,
          title: "Your chauffeur has been assigned",
          body: `Your chauffeur for ${booking.car.make} ${booking.car.model} (${booking.car.year}) has been assigned.`,
          payload: this.toPrismaInputJsonValue(inboxPayload),
        },
      });
    }

    if (!notificationJobData) {
      return;
    }

    await tx.notificationOutboxEvent.create({
      data: {
        userId: booking.userId ?? null,
        eventType: NotificationOutboxEventType.CHAUFFEUR_ASSIGNED,
        status: NotificationOutboxStatus.PENDING,
        dedupeKey,
        bookingId: booking.id,
        payload: this.toPrismaInputJsonValue({
          schemaVersion: 1,
          notificationJobData,
        }),
      },
    });
  }

  async processPendingEvents(limit = 25): Promise<number> {
    const now = new Date();
    const staleProcessingCutoff = new Date(now.getTime() - this.processingStaleAfterMs);
    const candidates = await this.databaseService.notificationOutboxEvent.findMany({
      where: {
        eventType: NotificationOutboxEventType.CHAUFFEUR_ASSIGNED,
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

    let processedCount = 0;
    for (const event of candidates) {
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
        continue;
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
          processedCount += 1;
          continue;
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
        processedCount += 1;
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
      }
    }

    return processedCount;
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

  private parseNotificationJobData(payload: Prisma.JsonValue | null): NotificationJobData | null {
    if (!this.isPlainObject(payload)) {
      return null;
    }

    if (payload.schemaVersion !== 1) {
      return null;
    }
    if (!this.isNotificationJobData(payload.notificationJobData)) {
      return null;
    }

    return payload.notificationJobData;
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private isNotificationJobData(value: unknown): value is NotificationJobData {
    if (!this.isPlainObject(value)) {
      return false;
    }

    return (
      typeof value.id === "string" &&
      typeof value.type === "string" &&
      typeof value.bookingId === "string" &&
      Array.isArray(value.channels) &&
      this.isPlainObject(value.recipients) &&
      this.isPlainObject(value.templateData)
    );
  }

  private toPrismaInputJsonValue(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value));
  }
}
