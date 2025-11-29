import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { Job } from "bullmq";
import {
  ACTIVE_TO_COMPLETED,
  CONFIRMED_TO_ACTIVE,
  STATUS_UPDATES_QUEUE,
} from "../../config/constants";
import { StatusUpdateJobData } from "./status-change.interface";
import { StatusChangeService } from "./status-change.service";

@Processor(STATUS_UPDATES_QUEUE)
export class StatusChangeProcessor extends WorkerHost {
  private readonly logger = new Logger(StatusChangeProcessor.name);

  constructor(private readonly statusChangeService: StatusChangeService) {
    super();
  }

  async process(job: Job<StatusUpdateJobData, any, string>) {
    this.logger.log(`Processing status update job: ${job.name}`, job.data);

    try {
      let result: string | undefined;

      if (job.name === CONFIRMED_TO_ACTIVE) {
        result = await this.statusChangeService.updateBookingsFromConfirmedToActive(
          job.data.timestamp,
        );
        this.logger.log(`Confirmed to active updates processed: ${result}`);
      } else if (job.name === ACTIVE_TO_COMPLETED) {
        result = await this.statusChangeService.updateBookingsFromActiveToCompleted(
          job.data.timestamp,
        );
        this.logger.log(`Active to completed updates processed: ${result}`);
      } else {
        throw new Error(`Unknown status update job type: ${job.name}`);
      }

      return { success: true, result };
    } catch (error) {
      this.logger.error(`Failed to process ${job.name} job:`, error);
      throw error;
    }
  }

  @OnWorkerEvent("completed")
  onCompleted(job: Job<StatusUpdateJobData>) {
    const duration = job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : "N/A";
    this.logger.log(`Job completed: ${job.name} [${job.id}] - Duration: ${duration}ms`);
  }

  @OnWorkerEvent("failed")
  onFailed(job: Job<StatusUpdateJobData>, error: Error) {
    this.logger.error(`Job failed: ${job.name} [${job.id}]`, {
      error: error.message,
      stack: error.stack,
      attempts: job.attemptsMade,
      maxAttempts: job.opts.attempts,
    });
  }

  @OnWorkerEvent("active")
  onActive(job: Job<StatusUpdateJobData>) {
    this.logger.log(`Job started: ${job.name} [${job.id}] - Attempt ${job.attemptsMade + 1}`);
  }

  @OnWorkerEvent("stalled")
  onStalled(jobId: string) {
    this.logger.warn(`Job stalled: ${jobId}`);
  }

  @OnWorkerEvent("progress")
  onProgress(job: Job<StatusUpdateJobData>, progress: number | object) {
    this.logger.debug(`Job progress: ${job.name} [${job.id}]`, progress);
  }
}
