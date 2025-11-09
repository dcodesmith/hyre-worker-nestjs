import { Injectable, Logger } from "@nestjs/common";
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
import { normaliseBookingLegDetails } from "../../shared/helper";
import { DatabaseService } from "../database/database.service";
import { NotificationType } from "../notification/notification.interface";
import { NotificationService } from "../notification/notification.service";
import { ReminderException } from "./errors";

@Injectable()
export class ReminderService {
  private readonly logger = new Logger(ReminderService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly notificationService: NotificationService,
  ) {}

  async sendBookingStartReminderEmails() {
    try {
      const now = new Date();
      this.logger.log(`now: ${now.toISOString()}, new Date(): ${new Date().toISOString()}`);

      const startOfToday = startOfDay(now);
      const endOfToday = endOfDay(now);

      this.logger.log(
        `Checking for booking legs starting today. startOfToday: ${startOfToday.toISOString()}, endOfToday: ${endOfToday.toISOString()}`,
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
        this.logger.log(
          "No booking legs found for today matching initial criteria. No start reminders to send.",
        );
        return "No relevant booking legs today, so no start reminders to send.";
      }

      let queuedCount = 0;
      for (const leg of legs) {
        this.logger.log(`Processing leg ${leg.id} legStartTime: ${leg.legStartTime}`);

        try {
          // Queue notification instead of sending directly
          await this.notificationService.queueBookingReminderNotifications(
            normaliseBookingLegDetails(leg),
            NotificationType.BOOKING_REMINDER_START,
          );
          queuedCount++;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.logger.error(
            `Failed to queue start reminder for leg ${leg.id}: ${errorMessage}`,
          );
          throw ReminderException.notificationQueueFailed(
            leg.id,
            "start",
            errorMessage,
          );
        }
      }

      this.logger.log("Email queue processing complete.");
      return `Processed and queued start reminders for ${queuedCount} legs.`;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error in sendBookingStartReminderEmails: ${errorMessage}`, {
        errorDetails: error,
      });
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

      this.logger.log(
        `Checking for booking legs ending today. Reminder window (local): ${reminderWindowStart.toISOString()} - ${reminderWindowEnd.toISOString()}`,
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
        this.logger.log(
          "No booking legs found for today meeting initial criteria. No end reminders to send.",
        );
        return "No relevant booking legs today, so no end reminders to send.";
      }

      this.logger.log(`Processing ${legsEndingToday.length} legs ending today for end reminders.`);

      let queuedCount = 0;
      for (const leg of legsEndingToday) {
        let effectiveEndTimeForLeg: Date;
        const latestActivePaidExtension = leg.extensions?.[0];

        if (latestActivePaidExtension?.extensionEndTime) {
          effectiveEndTimeForLeg = latestActivePaidExtension.extensionEndTime;
        } else {
          const parentBookingEndDate = leg.booking.endDate;
          effectiveEndTimeForLeg = set(leg.legDate, {
            hours: getHours(parentBookingEndDate),
            minutes: getMinutes(parentBookingEndDate),
            seconds: getSeconds(parentBookingEndDate),
            milliseconds: getMilliseconds(parentBookingEndDate),
          });
        }

        if (!isValid(effectiveEndTimeForLeg)) {
          this.logger.warn(
            `Could not determine valid effective end time for leg ${leg.id} of booking ${leg.booking.id}.`,
          );
          continue;
        }

        // Check if this leg's effective end time falls within the reminder window
        if (!isWithinInterval(effectiveEndTimeForLeg, reminderInterval)) {
          continue;
        }

        this.logger.log(
          `Processing end reminder for leg ${leg.id} with effective end time: ${effectiveEndTimeForLeg.toISOString()}`,
        );

        try {
          // Queue notification instead of sending directly
          await this.notificationService.queueBookingReminderNotifications(
            normaliseBookingLegDetails(leg),
            NotificationType.BOOKING_REMINDER_END,
          );
          queuedCount++;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.logger.error(
            `Failed to queue end reminder for leg ${leg.id}: ${errorMessage}`,
          );
          throw ReminderException.notificationQueueFailed(
            leg.id,
            "end",
            errorMessage,
          );
        }
      }

      return `Processed and queued end reminders for ${queuedCount} legs.`;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error in sendBookingEndReminderEmails: ${errorMessage}`, {
        errorDetails: error,
      });
      throw error;
    }
  }
}
