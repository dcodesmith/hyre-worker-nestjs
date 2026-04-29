import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { Queue } from "bullmq";
import { PinoLogger } from "nestjs-pino";
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
  constructor(
    @InjectQueue(REMINDERS_QUEUE) private readonly reminderQueue: Queue<ReminderJobData>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ReminderScheduler.name);
  }

  @Cron(EVERY_HOUR, { timeZone: TIMEZONE })
  async scheduleBookingStartReminders() {
    this.logger.info("Scheduling booking leg start reminder emails");

    try {
      await this.reminderQueue.add(
        BOOKING_LEG_START_REMINDER,
        { type: TRIP_START, timestamp: new Date().toISOString() },
        { removeOnComplete: true, removeOnFail: 25 },
      );
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to enqueue booking start reminders",
      );
    }
  }

  @Cron(EVERY_HOUR, { timeZone: TIMEZONE })
  async scheduleBookingEndReminders() {
    this.logger.info("Scheduling booking leg end reminder emails");

    try {
      await this.reminderQueue.add(
        BOOKING_LEG_END_REMINDER,
        { type: TRIP_END, timestamp: new Date().toISOString() },
        { removeOnComplete: true, removeOnFail: 25 },
      );
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to enqueue booking end reminders",
      );
    }
  }
}
