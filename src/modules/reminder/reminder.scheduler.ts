import { InjectQueue } from "@nestjs/bull";
import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { Queue } from "bull";
import {
  BOOKING_LEG_END_REMINDER,
  BOOKING_LEG_START_REMINDER,
  EVERY_HOUR,
  REMINDERS_QUEUE,
  TIMEZONE,
  TRIP_END,
  TRIP_START,
} from "../../config/constants";
import { ReminderJobData } from "./reminder.interface";

@Injectable()
export class ReminderScheduler {
  private readonly logger = new Logger(ReminderScheduler.name);

  constructor(
    @InjectQueue(REMINDERS_QUEUE) private readonly reminderQueue: Queue<ReminderJobData>,
  ) {}

  @Cron(EVERY_HOUR, { timeZone: TIMEZONE })
  async scheduleBookingStartReminders() {
    this.logger.log("Scheduling booking leg start reminder emails...");

    try {
      await this.reminderQueue.add(
        BOOKING_LEG_START_REMINDER,
        { type: TRIP_START, timestamp: new Date().toISOString() },
        { removeOnComplete: true, removeOnFail: 25 },
      );
    } catch (error) {
      this.logger.error(
        "Failed to enqueue booking start reminders",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  @Cron(EVERY_HOUR, { timeZone: TIMEZONE })
  async scheduleBookingEndReminders() {
    this.logger.log("Scheduling booking leg end reminder emails...");

    try {
      await this.reminderQueue.add(
        BOOKING_LEG_END_REMINDER,
        { type: TRIP_END, timestamp: new Date().toISOString() },
        { removeOnComplete: true, removeOnFail: 25 },
      );
    } catch (error) {
      this.logger.error(
        "Failed to enqueue booking end reminders",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
