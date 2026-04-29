import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { PinoLogger } from "nestjs-pino";
import { REFERRAL_QUEUE } from "../../config/constants";
import { PROCESS_REFERRAL_COMPLETION, ReferralJobData } from "./referral.interface";
import { ReferralProcessingService } from "./referral-processing.service";

@Processor(REFERRAL_QUEUE)
export class ReferralProcessor extends WorkerHost {
  constructor(
    private readonly referralProcessingService: ReferralProcessingService,
    private readonly logger: PinoLogger,
  ) {
    super();
    this.logger.setContext(ReferralProcessor.name);
  }

  async process(job: Job<ReferralJobData, void, string>): Promise<{ success: boolean }> {
    this.logger.info(
      {
        jobId: job.id,
        bookingId: job.data.bookingId,
      },
      `Processing referral job: ${job.name}`,
    );

    try {
      if (job.name === PROCESS_REFERRAL_COMPLETION) {
        await this.referralProcessingService.processReferralCompletionForBooking(
          job.data.bookingId,
        );
        this.logger.info(
          `Referral completion processed successfully for booking ${job.data.bookingId}`,
        );
        return { success: true };
      }

      throw new Error(`Unknown referral job type: ${job.name}`);
    } catch (error) {
      this.logger.error(
        {
          jobId: job.id,
          bookingId: job.data.bookingId,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : String(error),
        },
        `Failed to process ${job.name} job:`,
      );
      throw error; // Re-throw to trigger retry mechanism
    }
  }

  @OnWorkerEvent("completed")
  onCompleted(job: Job<ReferralJobData>): void {
    const duration = job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : "N/A";
    this.logger.info(
      {
        bookingId: job.data.bookingId,
      },
      `Job completed: ${job.name} [${job.id}] - Duration: ${duration}ms`,
    );
  }

  @OnWorkerEvent("failed")
  onFailed(job: Job<ReferralJobData> | undefined, error: Error): void {
    if (!job) {
      this.logger.error({ error: error.message }, "Job failed with no job context");
      return;
    }

    this.logger.error(
      {
        bookingId: job.data.bookingId,
        error: error.message,
        stack: error.stack,
        attempts: job.attemptsMade,
        maxAttempts: job.opts.attempts,
      },
      `Job failed: ${job.name} [${job.id}]`,
    );
  }

  @OnWorkerEvent("active")
  onActive(job: Job<ReferralJobData>): void {
    this.logger.info(
      {
        bookingId: job.data.bookingId,
      },
      `Job started: ${job.name} [${job.id}] - Attempt ${job.attemptsMade + 1}`,
    );
  }

  @OnWorkerEvent("stalled")
  onStalled(jobId: string): void {
    this.logger.warn(`Job stalled: ${jobId}`);
  }

  @OnWorkerEvent("progress")
  onProgress(job: Job<ReferralJobData>, progress: number | object): void {
    this.logger.debug(
      {
        bookingId: job.data.bookingId,
        progress,
      },
      `Job progress: ${job.name} [${job.id}]`,
    );
  }
}
