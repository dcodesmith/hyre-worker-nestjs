import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import { Queue } from "bullmq";
import { randomUUID } from "node:crypto";
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

@Injectable()
export class JobService {
  private readonly logger = new Logger(JobService.name);

  constructor(
    @InjectQueue(REMINDERS_QUEUE) private readonly reminderQueue: Queue,
    @InjectQueue(STATUS_UPDATES_QUEUE) private readonly statusUpdateQueue: Queue,
  ) {}

  async triggerStartBookingLegReminders() {
    await this.enqueue(this.reminderQueue, BOOKING_LEG_START_REMINDER, TRIP_START);
  }

  async triggerStatusUpdates() {
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
    this.logger.log(`Enqueued ${name} jobId=${jobId}`);
  }
}
