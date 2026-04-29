import { randomUUID } from "node:crypto";
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import { Queue } from "bullmq";
import { PinoLogger } from "nestjs-pino";
import {
  ACTIVE_TO_COMPLETED,
  BOOKING_LEG_END_REMINDER,
  BOOKING_LEG_START_REMINDER,
  CONFIRMED_TO_ACTIVE,
  REMINDERS_QUEUE,
  STATUS_UPDATES_QUEUE,
  TRIP_END,
  TRIP_START,
} from "../../config/constants";
import { JobEnqueueFailedException } from "./errors";

@Injectable()
export class JobService {
  constructor(
    @InjectQueue(REMINDERS_QUEUE) private readonly reminderQueue: Queue,
    @InjectQueue(STATUS_UPDATES_QUEUE) private readonly statusUpdateQueue: Queue,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(JobService.name);
  }

  async triggerStartBookingLegReminders() {
    await this.enqueue(this.reminderQueue, BOOKING_LEG_START_REMINDER, TRIP_START);
  }

  async triggerActivateBookings() {
    await this.enqueue(this.statusUpdateQueue, CONFIRMED_TO_ACTIVE, CONFIRMED_TO_ACTIVE);
  }

  async triggerBookingLegEndReminders() {
    await this.enqueue(this.reminderQueue, BOOKING_LEG_END_REMINDER, TRIP_END);
  }

  async triggerCompleteBookings() {
    await this.enqueue(this.statusUpdateQueue, ACTIVE_TO_COMPLETED, ACTIVE_TO_COMPLETED);
  }

  private async enqueue(queue: Queue, name: string, type: string) {
    const timestamp = new Date().toISOString();
    const jobId = `${name}-${timestamp}-${randomUUID().slice(0, 8)}`;

    try {
      await queue.add(
        name,
        { type, timestamp },
        {
          jobId,
          removeOnComplete: 100,
          removeOnFail: 50,
          attempts: 3,
          backoff: { type: "exponential", delay: 1000 },
        },
      );
      this.logger.info({ jobName: name, jobId }, "Enqueued job");
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(
        {
          jobName: name,
          jobId,
          error: errorMessage,
          stack: error instanceof Error ? error.stack : undefined,
        },
        "Failed to enqueue job",
      );
      throw new JobEnqueueFailedException(name, errorMessage);
    }
  }
}
