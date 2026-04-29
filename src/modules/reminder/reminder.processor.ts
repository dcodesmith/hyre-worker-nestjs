import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject } from "@nestjs/common";
import { Job } from "bullmq";
import { PinoLogger } from "nestjs-pino";
import {
  BOOKING_LEG_END_REMINDER,
  BOOKING_LEG_START_REMINDER,
  REMINDERS_QUEUE,
} from "../../config/constants";
import { ReminderJobData } from "./reminder.interface";
import { ReminderService } from "./reminder.service";

@Processor(REMINDERS_QUEUE)
export class ReminderProcessor extends WorkerHost {
  constructor(
    private readonly reminderService: ReminderService,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {
    super();
    this.logger.setContext(ReminderProcessor.name);
  }

  async process(job: Job<ReminderJobData, { success: boolean; result?: string }, string>) {
    this.logger.info({ jobName: job.name, jobData: job.data }, "Processing reminder job");

    try {
      let result: string | undefined;

      if (job.name === BOOKING_LEG_START_REMINDER) {
        result = await this.reminderService.sendBookingStartReminderEmails();
        this.logger.info({ result }, "Booking start reminders processed");
      } else if (job.name === BOOKING_LEG_END_REMINDER) {
        result = await this.reminderService.sendBookingEndReminderEmails();
        this.logger.info({ result }, "Booking end reminders processed");
      } else {
        throw new Error(`Unknown reminder job type: ${job.name}`);
      }

      return { success: true, result };
    } catch (error) {
      this.logger.error(
        {
          jobName: job.name,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        "Failed to process reminder job",
      );
      throw error;
    }
  }

  @OnWorkerEvent("completed")
  onCompleted(job: Job<ReminderJobData>) {
    const duration = job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : "N/A";
    this.logger.info({ jobName: job.name, jobId: job.id, durationMs: duration }, "Job completed");
  }

  @OnWorkerEvent("failed")
  onFailed(job: Job<ReminderJobData>, error: Error) {
    this.logger.error(
      {
        jobName: job.name,
        jobId: job.id,
        error: error.message,
        stack: error.stack,
        attempts: job.attemptsMade,
        maxAttempts: job.opts.attempts,
      },
      "Job failed",
    );
  }

  @OnWorkerEvent("active")
  onActive(job: Job<ReminderJobData>) {
    this.logger.info(
      { jobName: job.name, jobId: job.id, attempt: job.attemptsMade + 1 },
      "Job started",
    );
  }

  @OnWorkerEvent("stalled")
  onStalled(jobId: string) {
    this.logger.warn({ jobId }, "Job stalled");
  }

  @OnWorkerEvent("progress")
  onProgress(job: Job<ReminderJobData>, progress: number | object) {
    this.logger.debug({ jobName: job.name, jobId: job.id, progress }, "Job progress");
  }
}
