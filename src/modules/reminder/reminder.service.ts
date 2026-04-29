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
import { normaliseBookingLegDetails } from "../../shared/helper";
import { DatabaseService } from "../database/database.service";
import { NotificationType } from "../notification/notification.interface";
import { NotificationService } from "../notification/notification.service";

const REMINDER_LABEL_BY_TYPE = {
  [NotificationType.BOOKING_REMINDER_START]: "start",
  [NotificationType.BOOKING_REMINDER_END]: "end",
} as const satisfies Record<
  NotificationType.BOOKING_REMINDER_START | NotificationType.BOOKING_REMINDER_END,
  "start" | "end"
>;

@Injectable()
export class ReminderService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly notificationService: NotificationService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ReminderService.name);
  }

  async sendBookingStartReminderEmails() {
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

      let queuedCount = 0;
      for (const leg of legs) {
        this.logger.info(
          { legId: leg.id, legStartTime: leg.legStartTime.toISOString() },
          "Processing booking leg start reminder",
        );

        const queued = await this.queueReminderForLeg(leg, NotificationType.BOOKING_REMINDER_START);
        if (queued) {
          queuedCount++;
        }
      }

      this.logger.info({ queuedCount }, "Booking start reminder queue processing complete");
      return `Processed and queued start reminders for ${queuedCount} legs.`;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { error: errorMessage, errorDetails: error },
        "Error in sendBookingStartReminderEmails",
      );
      throw error;
    }
  }

  async sendBookingEndReminderEmails() {
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

      let queuedCount = 0;
      for (const leg of legsEndingToday) {
        const effectiveEndTime = this.calculateEffectiveEndTime(leg);
        if (!effectiveEndTime || !isWithinInterval(effectiveEndTime, reminderInterval)) {
          continue;
        }

        this.logger.info(
          { legId: leg.id, effectiveEndTime: effectiveEndTime.toISOString() },
          "Processing booking leg end reminder",
        );

        const queued = await this.queueReminderForLeg(leg, NotificationType.BOOKING_REMINDER_END);
        if (queued) {
          queuedCount++;
        }
      }

      return `Processed and queued end reminders for ${queuedCount} legs.`;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { error: errorMessage, errorDetails: error },
        "Error in sendBookingEndReminderEmails",
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

  private async queueReminderForLeg(
    leg: Parameters<typeof normaliseBookingLegDetails>[0],
    type: NotificationType.BOOKING_REMINDER_START | NotificationType.BOOKING_REMINDER_END,
  ): Promise<boolean> {
    return this.queueReminderNotification(
      leg.id,
      () =>
        this.notificationService.queueBookingReminderNotifications(
          normaliseBookingLegDetails(leg),
          type,
        ),
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
