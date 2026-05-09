import { Injectable } from "@nestjs/common";
import {
  NotificationInboxType,
  NotificationOutboxEventType,
  NotificationOutboxStatus,
  Prisma,
} from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { z } from "zod";
import { normaliseBookingLegDetails } from "../../shared/helper";
import type { BookingWithRelations } from "../../types";
import { DatabaseService } from "../database/database.service";
import {
  CHAUFFEUR_RECIPIENT_TYPE,
  CLIENT_RECIPIENT_TYPE,
  HIGH_PRIORITY_JOB_OPTIONS,
} from "./notification.const";
import { NotificationJobData, NotificationType } from "./notification.interface";
import { notificationJobDataSchema } from "./notification.schema";
import { NotificationService } from "./notification.service";

export type NotificationOutboxTransactionClient = {
  notificationInbox: Pick<Prisma.TransactionClient["notificationInbox"], "create">;
  notificationOutboxEvent: Pick<Prisma.TransactionClient["notificationOutboxEvent"], "create">;
  userPushToken: Pick<Prisma.TransactionClient["userPushToken"], "findMany">;
};

type NotificationOutboxWriter = Pick<
  NotificationOutboxTransactionClient,
  "notificationInbox" | "notificationOutboxEvent"
>;

const BOOKING_STATUS_CHANGED_SUBTYPE = "BOOKING_STATUS_CHANGED";
const BOOKING_REMINDER_START_SUBTYPE = "BOOKING_REMINDER_START";
const BOOKING_REMINDER_END_SUBTYPE = "BOOKING_REMINDER_END";
const CHAUFFEUR_ASSIGNED_SUBTYPE = "CHAUFFEUR_ASSIGNED";

/**
 * Structural validator for outbox payloads. The (eventType, subtype) pair is
 * the discriminator — adding a versioning envelope is deferred until we
 * actually need to evolve through a backwards-incompatible change.
 */
const outboxPayloadSchema = z.discriminatedUnion("eventType", [
  z.object({
    eventType: z.literal(NotificationOutboxEventType.BOOKING_ASSIGNMENT),
    subtype: z.literal(CHAUFFEUR_ASSIGNED_SUBTYPE),
    notificationJobData: notificationJobDataSchema,
  }),
  z.object({
    eventType: z.literal(NotificationOutboxEventType.BOOKING_LIFECYCLE),
    subtype: z.literal(BOOKING_STATUS_CHANGED_SUBTYPE),
    notificationJobData: notificationJobDataSchema,
  }),
  z.object({
    eventType: z.literal(NotificationOutboxEventType.BOOKING_REMINDER),
    subtype: z.enum([BOOKING_REMINDER_START_SUBTYPE, BOOKING_REMINDER_END_SUBTYPE]),
    notificationJobData: notificationJobDataSchema,
  }),
]);

@Injectable()
export class NotificationOutboxService {
  private readonly maxAttempts = 8;
  private readonly processingStaleAfterMs = 2 * 60 * 1000;
  private readonly processingBatchSize = 5;
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
          type: NotificationInboxType.BOOKING_ASSIGNMENT,
          title: "Your chauffeur has been assigned",
          body: `Your chauffeur for ${booking.car.make} ${booking.car.model} (${booking.car.year}) has been assigned.`,
          payload: this.toPrismaInputJsonValue(inboxPayload),
        },
      });
    }

    if (!notificationJobData) {
      return;
    }

    await this.createPreparedNotificationEvent(
      {
        userId: booking.userId ?? null,
        eventType: NotificationOutboxEventType.BOOKING_ASSIGNMENT,
        subtype: CHAUFFEUR_ASSIGNED_SUBTYPE,
        dedupeKey,
        bookingId: booking.id,
        notificationJobData,
      },
      tx,
    );
  }

  async createBookingStatusChangedEvent(
    tx: NotificationOutboxTransactionClient,
    booking: BookingWithRelations,
    oldStatus: string,
    newStatus: string,
    showReviewRequest = false,
  ): Promise<void> {
    const notificationJobData = await this.notificationService.buildBookingStatusChangeJobData({
      booking,
      oldStatus,
      newStatus,
      showReviewRequest,
    });
    if (!notificationJobData) {
      return;
    }

    if (booking.userId) {
      await tx.notificationInbox.create({
        data: {
          userId: booking.userId,
          type: NotificationInboxType.BOOKING_LIFECYCLE,
          title: "Booking status updated",
          body: `Your booking has moved from ${oldStatus.toLowerCase()} to ${newStatus.toLowerCase()}.`,
          payload: this.toPrismaInputJsonValue({
            bookingId: booking.id,
            oldStatus,
            newStatus,
          }),
        },
      });
    }

    await this.createPreparedNotificationEvent(
      {
        userId: booking.userId ?? null,
        eventType: NotificationOutboxEventType.BOOKING_LIFECYCLE,
        subtype: BOOKING_STATUS_CHANGED_SUBTYPE,
        dedupeKey: `booking-status:${booking.id}:${oldStatus}:${newStatus}:${booking.updatedAt.toISOString()}`,
        bookingId: booking.id,
        notificationJobData,
      },
      tx,
    );
  }

  async createBookingReminderEventsForLeg(
    bookingLeg: Parameters<typeof normaliseBookingLegDetails>[0],
    type: NotificationType.BOOKING_REMINDER_START | NotificationType.BOOKING_REMINDER_END,
  ): Promise<number> {
    const reminderJobs = await this.notificationService.buildBookingReminderJobData(
      normaliseBookingLegDetails(bookingLeg),
      type,
      {
        customerUserId: bookingLeg.booking.userId ?? undefined,
        chauffeurUserId: bookingLeg.booking.chauffeurId ?? undefined,
      },
    );
    const eventType = NotificationOutboxEventType.BOOKING_REMINDER;
    const subtype =
      type === NotificationType.BOOKING_REMINDER_START
        ? BOOKING_REMINDER_START_SUBTYPE
        : BOOKING_REMINDER_END_SUBTYPE;
    const inboxTitle =
      type === NotificationType.BOOKING_REMINDER_START
        ? "Booking starts in 1 hour"
        : "Booking ends in 1 hour";
    const inboxBody =
      type === NotificationType.BOOKING_REMINDER_START
        ? "Your booking is starting soon."
        : "Your booking is ending soon.";

    let writtenCount = 0;
    // Run per-recipient writes sequentially so each recipient's inbox + outbox
    // commit atomically. Reminder fan-out is at most customer + chauffeur, so
    // serialising is a non-issue and avoids parallel transactions on the pool.
    for (const notificationJobData of reminderJobs) {
      const recipientType = Object.keys(notificationJobData.recipients)[0];
      let userId: string | null = null;
      if (recipientType === CLIENT_RECIPIENT_TYPE) {
        userId = bookingLeg.booking.userId;
      } else if (recipientType === CHAUFFEUR_RECIPIENT_TYPE) {
        userId = bookingLeg.booking.chauffeurId;
      }

      await this.databaseService.$transaction(async (tx) => {
        if (userId) {
          await tx.notificationInbox.create({
            data: {
              userId,
              type: NotificationInboxType.BOOKING_REMINDER,
              title: inboxTitle,
              body: inboxBody,
              payload: this.toPrismaInputJsonValue({
                bookingId: bookingLeg.booking.id,
                bookingLegId: bookingLeg.id,
                type,
                recipientType,
              }),
            },
          });
        }

        await this.createPreparedNotificationEvent(
          {
            userId: userId ?? null,
            eventType,
            subtype,
            dedupeKey: `booking-reminder:${bookingLeg.id}:${recipientType}:${type}:${bookingLeg.updatedAt.toISOString()}`,
            bookingId: bookingLeg.booking.id,
            notificationJobData,
          },
          tx,
        );
      });
      writtenCount += 1;
    }

    return writtenCount;
  }

  async processPendingEvents(limit = 25): Promise<number> {
    const now = new Date();
    const staleProcessingCutoff = new Date(now.getTime() - this.processingStaleAfterMs);
    const candidates = await this.databaseService.notificationOutboxEvent.findMany({
      where: {
        eventType: {
          in: [
            NotificationOutboxEventType.BOOKING_ASSIGNMENT,
            NotificationOutboxEventType.BOOKING_LIFECYCLE,
            NotificationOutboxEventType.BOOKING_REMINDER,
            NotificationOutboxEventType.CHAUFFEUR_ASSIGNED,
          ],
        },
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
    for (const batch of this.chunkArray(candidates, this.processingBatchSize)) {
      const batchResults = await Promise.all(
        batch.map((event) => this.processEvent(event, staleProcessingCutoff, now)),
      );
      processedCount += batchResults.reduce((sum, count) => sum + count, 0);
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
        return 1;
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

  private async createPreparedNotificationEvent(
    input: {
      userId: string | null;
      eventType: NotificationOutboxEventType;
      subtype:
        | typeof CHAUFFEUR_ASSIGNED_SUBTYPE
        | typeof BOOKING_STATUS_CHANGED_SUBTYPE
        | typeof BOOKING_REMINDER_START_SUBTYPE
        | typeof BOOKING_REMINDER_END_SUBTYPE;
      dedupeKey: string;
      bookingId: string;
      notificationJobData: NotificationJobData;
    },
    tx?: NotificationOutboxTransactionClient,
  ): Promise<void> {
    const writer = this.getOutboxWriter(tx);
    await writer.notificationOutboxEvent.create({
      data: {
        userId: input.userId,
        eventType: input.eventType,
        status: NotificationOutboxStatus.PENDING,
        dedupeKey: input.dedupeKey,
        bookingId: input.bookingId,
        payload: this.toPrismaInputJsonValue({
          eventType: input.eventType,
          subtype: input.subtype,
          notificationJobData: input.notificationJobData,
        }),
      },
    });
  }

  private getOutboxWriter(tx?: NotificationOutboxTransactionClient): NotificationOutboxWriter {
    if (tx) {
      return tx;
    }
    return this.databaseService;
  }

  private chunkArray<T>(items: T[], size: number): T[][] {
    if (items.length === 0) {
      return [];
    }

    const chunks: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
      chunks.push(items.slice(index, index + size));
    }
    return chunks;
  }

  private toPrismaInputJsonValue(value: unknown): Prisma.InputJsonValue {
    return structuredClone(value) as Prisma.InputJsonValue;
  }
}
