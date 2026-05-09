import { Injectable } from "@nestjs/common";
import { BookingStatus, PaymentStatus, Status } from "@prisma/client";
import {
  addHours,
  addMinutes,
  endOfDay,
  getHours,
  getMilliseconds,
  getMinutes,
  getSeconds,
  isValid,
  isWithinInterval,
  set,
  startOfDay,
  subMilliseconds,
} from "date-fns";
import { PinoLogger } from "nestjs-pino";
import pLimit from "p-limit";
import { normaliseBookingLegDetails } from "../../shared/helper";
import { DatabaseService } from "../database/database.service";
import { BookingReminderHandler } from "../notification/handlers/booking-reminder.handler";
import { NotificationType } from "../notification/notification.interface";
import { NotificationOutboxService } from "../notification/notification-outbox.service";
import { PushTokenService } from "../notification/push-token.service";

const REMINDER_LABEL_BY_TYPE = {
  [NotificationType.BOOKING_REMINDER_START]: "start",
  [NotificationType.BOOKING_REMINDER_END]: "end",
} as const satisfies Record<
  NotificationType.BOOKING_REMINDER_START | NotificationType.BOOKING_REMINDER_END,
  "start" | "end"
>;

/**
 * Cap on concurrent leg-fan-out within a single reminder cron tick. Each leg
 * does up to 2 outbox writes (customer + chauffeur), so 8 concurrent legs ≈
 * 16 in-flight DB writes — well below pool size while reducing burst latency
 * versus sequential processing (Issue 14A).
 */
const REMINDER_CONCURRENCY = 8;

type ReminderLeg = Parameters<typeof normaliseBookingLegDetails>[0];

@Injectable()
export class ReminderService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly notificationOutboxService: NotificationOutboxService,
    private readonly bookingReminderHandler: BookingReminderHandler,
    private readonly pushTokenService: PushTokenService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ReminderService.name);
  }

  async sendBookingStartReminders() {
    try {
      const now = new Date();
      this.logger.info(
        { now: now.toISOString(), currentDate: new Date().toISOString() },
        "Preparing booking start reminder query",
      );

      const startOfToday = startOfDay(now);
      const endOfToday = endOfDay(now);

      this.logger.info(
        { startOfToday: startOfToday.toISOString(), endOfToday: endOfToday.toISOString() },
        "Checking for booking legs starting today",
      );

      const oneHourFromNow = addHours(now, 1);
      const windowEndTime = subMilliseconds(oneHourFromNow, 1);

      // 1. Fetch BookingLegs for today whose parent booking meets criteria.
      const legs = await this.databaseService.bookingLeg.findMany({
        where: {
          legDate: {
            gte: startOfToday,
            lte: endOfToday,
          },
          legStartTime: {
            gte: now, // Leg start time is at or after the current moment
            lte: windowEndTime, // Leg start time is at or before one hour from now
          },
          booking: {
            status: BookingStatus.CONFIRMED,
            paymentStatus: PaymentStatus.PAID,
            chauffeur: { isNot: null },
            car: { status: Status.BOOKED },
          },
        },
        include: {
          extensions: true,
          booking: {
            include: {
              user: true,
              chauffeur: true,
              car: { include: { owner: true } },
            },
          },
        },
      });

      if (legs.length === 0) {
        this.logger.info("No booking legs found for today matching initial criteria");
        return "No relevant booking legs today, so no start reminders to send.";
      }

      const tokensByUserId = await this.prefetchPushTokensForLegs(legs);
      const limit = pLimit(REMINDER_CONCURRENCY);
      const results = await Promise.all(
        legs.map((leg) =>
          limit(() => {
            this.logger.info(
              { legId: leg.id, legStartTime: leg.legStartTime.toISOString() },
              "Processing booking leg start reminder",
            );
            return this.queueReminderForLeg(
              leg,
              NotificationType.BOOKING_REMINDER_START,
              tokensByUserId,
            );
          }),
        ),
      );
      const queuedCount = results.filter(Boolean).length;

      this.logger.info({ queuedCount }, "Booking start reminder queue processing complete");
      return `Processed and queued start reminders for ${queuedCount} legs.`;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { error: errorMessage, errorDetails: error },
        "Error in sendBookingStartReminders",
      );
      throw error;
    }
  }

  async sendBookingEndReminders() {
    try {
      const now = new Date();

      // Define UTC day boundaries for querying legDate
      const todayUtcYear = now.getUTCFullYear();
      const todayUtcMonth = now.getUTCMonth();
      const todayUtcDay = now.getUTCDate();

      const startOfTodayUTC = new Date(
        Date.UTC(todayUtcYear, todayUtcMonth, todayUtcDay, 0, 0, 0, 0),
      );
      const endOfTodayUTC = new Date(
        Date.UTC(todayUtcYear, todayUtcMonth, todayUtcDay, 23, 59, 59, 999),
      );

      // Define the reminder window (local time)
      const reminderTargetTime = addMinutes(now, 60);
      const reminderWindowStart = set(reminderTargetTime, {
        seconds: 0,
        milliseconds: 0,
      });
      const reminderWindowEnd = set(reminderTargetTime, {
        seconds: 59,
        milliseconds: 999,
      });
      const reminderInterval = {
        start: reminderWindowStart,
        end: reminderWindowEnd,
      };

      this.logger.info(
        {
          reminderWindowStart: reminderWindowStart.toISOString(),
          reminderWindowEnd: reminderWindowEnd.toISOString(),
        },
        "Checking for booking legs ending today",
      );

      // Fetch legs ending today with all necessary relations included
      const legsEndingToday = await this.databaseService.bookingLeg.findMany({
        where: {
          legDate: {
            gte: startOfTodayUTC,
            lte: endOfTodayUTC,
          },
          booking: {
            status: BookingStatus.ACTIVE,
            paymentStatus: PaymentStatus.PAID,
            car: {
              status: Status.BOOKED,
            },
          },
        },
        include: {
          extensions: {
            where: {
              paymentStatus: PaymentStatus.PAID,
              status: "ACTIVE",
            },
            orderBy: { extensionEndTime: "desc" },
          },
          booking: {
            include: {
              user: true,
              chauffeur: true,
              car: { include: { owner: true } },
            },
          },
        },
      });

      if (legsEndingToday.length === 0) {
        this.logger.info("No booking legs found for today meeting initial criteria");
        return "No relevant booking legs today, so no end reminders to send.";
      }

      this.logger.info(
        { legsCount: legsEndingToday.length },
        "Processing legs ending today for end reminders",
      );

      const dueLegs = legsEndingToday.filter((leg) => {
        const effectiveEndTime = this.calculateEffectiveEndTime(leg);
        return effectiveEndTime !== null && isWithinInterval(effectiveEndTime, reminderInterval);
      });

      if (dueLegs.length === 0) {
        return "Processed and queued end reminders for 0 legs.";
      }

      const tokensByUserId = await this.prefetchPushTokensForLegs(dueLegs);
      const limit = pLimit(REMINDER_CONCURRENCY);
      const results = await Promise.all(
        dueLegs.map((leg) =>
          limit(() => {
            this.logger.info({ legId: leg.id }, "Processing booking leg end reminder");
            return this.queueReminderForLeg(
              leg,
              NotificationType.BOOKING_REMINDER_END,
              tokensByUserId,
            );
          }),
        ),
      );
      const queuedCount = results.filter(Boolean).length;

      return `Processed and queued end reminders for ${queuedCount} legs.`;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { error: errorMessage, errorDetails: error },
        "Error in sendBookingEndReminders",
      );
      throw error;
    }
  }

  private calculateEffectiveEndTime(leg: {
    extensions?: Array<{ extensionEndTime: Date | null }>;
    legDate: Date;
    booking: { endDate: Date; id: string };
    id: string;
  }): Date | null {
    let effectiveEndTime: Date;

    const latestActivePaidExtension = leg.extensions?.[0];

    if (latestActivePaidExtension?.extensionEndTime) {
      effectiveEndTime = latestActivePaidExtension.extensionEndTime;
    } else {
      const parentBookingEndDate = leg.booking.endDate;
      effectiveEndTime = set(leg.legDate, {
        hours: getHours(parentBookingEndDate),
        minutes: getMinutes(parentBookingEndDate),
        seconds: getSeconds(parentBookingEndDate),
        milliseconds: getMilliseconds(parentBookingEndDate),
      });
    }

    if (!isValid(effectiveEndTime)) {
      this.logger.warn(
        { legId: leg.id, bookingId: leg.booking.id },
        "Could not determine valid effective end time",
      );
      return null;
    }

    return effectiveEndTime;
  }

  /**
   * Batch-fetch active push tokens for every customer + chauffeur across the
   * given legs in a single round-trip. Replaces N+1 per-recipient lookups
   * inside `RecipientChannelResolverService.resolve()` (Issue 13A).
   */
  private async prefetchPushTokensForLegs(legs: ReminderLeg[]): Promise<Record<string, string[]>> {
    const userIds = new Set<string>();
    for (const leg of legs) {
      if (leg.booking.userId) {
        userIds.add(leg.booking.userId);
      }
      if (leg.booking.chauffeurId) {
        userIds.add(leg.booking.chauffeurId);
      }
    }

    if (userIds.size === 0) {
      return {};
    }

    return this.pushTokenService.getActiveTokensForUsers([...userIds]);
  }

  private async queueReminderForLeg(
    leg: ReminderLeg,
    type: NotificationType.BOOKING_REMINDER_START | NotificationType.BOOKING_REMINDER_END,
    tokensByUserId: Record<string, string[]>,
  ): Promise<boolean> {
    return this.queueReminderNotification(
      leg.id,
      async () => {
        await this.notificationOutboxService.create(this.bookingReminderHandler, {
          bookingLeg: leg,
          type,
          context: {
            customerPushTokens: leg.booking.userId
              ? (tokensByUserId[leg.booking.userId] ?? [])
              : undefined,
            chauffeurPushTokens: leg.booking.chauffeurId
              ? (tokensByUserId[leg.booking.chauffeurId] ?? [])
              : undefined,
          },
        });
      },
      REMINDER_LABEL_BY_TYPE[type],
    );
  }

  private async queueReminderNotification(
    legId: string,
    action: () => Promise<void>,
    reminderLabel: "start" | "end",
  ): Promise<boolean> {
    try {
      await action();
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error({ reminderLabel, legId, error: errorMessage }, "Failed to queue reminder");
      return false;
    }
  }
}
