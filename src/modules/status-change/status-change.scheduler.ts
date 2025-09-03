import { InjectQueue } from "@nestjs/bull";
import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { Queue } from "bull";

interface StatusUpdateJobData {
  type: "confirmed-to-active" | "active-to-completed";
  timestamp: string;
}

@Injectable()
export class StatusChangeScheduler {
  private readonly logger = new Logger(StatusChangeScheduler.name);

  constructor(
    @InjectQueue("status-updates") private readonly statusUpdateQueue: Queue<StatusUpdateJobData>,
  ) {}

  @Cron("0 7-12,23 * * *") // At minute 0 of every hour 7–12 and at 23:00
  async scheduleConfirmedToActiveUpdates() {
    this.logger.log("Scheduling confirmed to active status updates...");
    await this.statusUpdateQueue.add("confirmed-to-active", {
      type: "confirmed-to-active",
      timestamp: new Date().toISOString(),
    });
  }

  @Cron("0 0,5,19-23 * * *") // At minute 0 of 19:00–23:00, 00:00, and now 05:00 every day
  async scheduleActiveToCompletedUpdates() {
    this.logger.log("Scheduling active to completed status updates...");
    await this.statusUpdateQueue.add("active-to-completed", {
      type: "active-to-completed",
      timestamp: new Date().toISOString(),
    });
  }
}
