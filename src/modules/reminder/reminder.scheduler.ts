import { InjectQueue } from "@nestjs/bull";
import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { Queue } from "bull";

interface ReminderJobData {
  type: "trip-start" | "trip-end";
  timestamp: string;
}

@Injectable()
export class ReminderScheduler {
  private readonly logger = new Logger(ReminderScheduler.name);

  constructor(
    @InjectQueue("reminder-emails") private readonly reminderQueue: Queue<ReminderJobData>,
  ) {}

  @Cron("0 6-11,22 * * *") // At minute 0 of 6–11 and 22 (10pm) every day
  async scheduleBookingStartReminders() {
    this.logger.log("Scheduling booking leg start reminder emails...");
    await this.reminderQueue.add("booking-leg-start-reminder", {
      type: "trip-start",
      timestamp: new Date().toISOString(),
    });
  }

  @Cron("0 4,18-23 * * *") // At 04:00, then on the hour 18–23 every day
  async scheduleBookingEndReminders() {
    this.logger.log("Scheduling booking leg end reminder emails...");
    await this.reminderQueue.add("booking-leg-end-reminder", {
      type: "trip-end",
      timestamp: new Date().toISOString(),
    });
  }
}
