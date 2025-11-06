import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { Job } from "bullmq";
import {
  BOOKING_LEG_END_REMINDER,
  BOOKING_LEG_START_REMINDER,
  REMINDERS_QUEUE,
} from "../../config/constants";
import { ReminderJobData } from "./reminder.interface";
import { ReminderService } from "./reminder.service";

@Processor(REMINDERS_QUEUE)
export class ReminderProcessor extends WorkerHost {
  private readonly logger = new Logger(ReminderProcessor.name);

  constructor(private readonly reminderService: ReminderService) {
    super();
  }

  async process(job: Job<ReminderJobData, any, string>) {
    this.logger.log(`Processing reminder job: ${job.name}`, job.data);

    try {
      let result: string | undefined;

      if (job.name === BOOKING_LEG_START_REMINDER) {
        result = await this.reminderService.sendBookingStartReminderEmails();
        this.logger.log("Booking start reminders processed:", result);
      } else if (job.name === BOOKING_LEG_END_REMINDER) {
        result = await this.reminderService.sendBookingEndReminderEmails();
        this.logger.log("Booking end reminders processed:", result);
      } else {
        throw new Error(`Unknown reminder job type: ${job.name}`);
      }

      return { success: true, result };
    } catch (error) {
      this.logger.error(`Failed to process ${job.name} job:`, error);
      throw error;
    }
  }

  @OnWorkerEvent("completed")
  onCompleted(job: Job<ReminderJobData>) {
    const duration = job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : "N/A";
    this.logger.log(`Job completed: ${job.name} [${job.id}] - Duration: ${duration}ms`);
  }

  @OnWorkerEvent("failed")
  onFailed(job: Job<ReminderJobData>, error: Error) {
    this.logger.error(`Job failed: ${job.name} [${job.id}]`, {
      error: error.message,
      stack: error.stack,
      attempts: job.attemptsMade,
      maxAttempts: job.opts.attempts,
    });
  }

  @OnWorkerEvent("active")
  onActive(job: Job<ReminderJobData>) {
    this.logger.log(`Job started: ${job.name} [${job.id}] - Attempt ${job.attemptsMade + 1}`);
  }

  @OnWorkerEvent("stalled")
  onStalled(jobId: string) {
    this.logger.warn(`Job stalled: ${jobId}`);
  }

  @OnWorkerEvent("progress")
  onProgress(job: Job<ReminderJobData>, progress: number | object) {
    this.logger.debug(`Job progress: ${job.name} [${job.id}]`, progress);
  }
}
