import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { Queue } from "bullmq";
import { PinoLogger } from "nestjs-pino";
import {
  ACTIVE_TO_COMPLETED,
  CONFIRMED_TO_ACTIVE,
  EVERY_HOUR,
  STATUS_UPDATES_QUEUE,
  TIMEZONE,
} from "../../config/constants";
import { StatusUpdateSchedulingFailedException } from "./status-change.error";
import { StatusUpdateJobData } from "./status-change.interface";

@Injectable()
export class StatusChangeScheduler {
  constructor(
    @InjectQueue(STATUS_UPDATES_QUEUE)
    private readonly statusUpdateQueue: Queue<StatusUpdateJobData>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(StatusChangeScheduler.name);
  }

  @Cron(EVERY_HOUR, { timeZone: TIMEZONE })
  async scheduleConfirmedToActiveUpdates() {
    this.logger.info("Scheduling confirmed to active status updates");

    try {
      await this.statusUpdateQueue.add(CONFIRMED_TO_ACTIVE, {
        type: CONFIRMED_TO_ACTIVE,
      });
    } catch (error) {
      const schedulingError = new StatusUpdateSchedulingFailedException(
        CONFIRMED_TO_ACTIVE,
        error instanceof Error ? error.message : String(error),
      );
      this.logger.error(
        { error: schedulingError.message },
        "Failed to schedule confirmed to active status updates",
      );
    }
  }

  @Cron(EVERY_HOUR, { timeZone: TIMEZONE })
  async scheduleActiveToCompletedUpdates() {
    this.logger.info("Scheduling active to completed status updates");

    try {
      await this.statusUpdateQueue.add(ACTIVE_TO_COMPLETED, {
        type: ACTIVE_TO_COMPLETED,
      });
    } catch (error) {
      const schedulingError = new StatusUpdateSchedulingFailedException(
        ACTIVE_TO_COMPLETED,
        error instanceof Error ? error.message : String(error),
      );
      this.logger.error(
        { error: schedulingError.message },
        "Failed to schedule active to completed status updates",
      );
    }
  }
}
