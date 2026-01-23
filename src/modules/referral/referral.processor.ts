import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { Job } from "bullmq";
import { REFERRAL_QUEUE } from "../../config/constants";
import { PROCESS_REFERRAL_COMPLETION, ReferralJobData } from "./referral.interface";
import { ReferralService } from "./referral.service";

@Processor(REFERRAL_QUEUE)
export class ReferralProcessor extends WorkerHost {
  private readonly logger = new Logger(ReferralProcessor.name);

  constructor(private readonly referralService: ReferralService) {
    super();
  }

  async process(job: Job<ReferralJobData, void, string>): Promise<{ success: boolean }> {
    this.logger.log(`Processing referral job: ${job.name}`, {
      jobId: job.id,
      bookingId: job.data.bookingId,
    });

    try {
      if (job.name === PROCESS_REFERRAL_COMPLETION) {
        await this.referralService.processReferralCompletionForBooking(job.data.bookingId);
        this.logger.log(
          `Referral completion processed successfully for booking ${job.data.bookingId}`,
        );
        return { success: true };
      }

      throw new Error(`Unknown referral job type: ${job.name}`);
    } catch (error) {
      this.logger.error(`Failed to process ${job.name} job:`, {
        jobId: job.id,
        bookingId: job.data.bookingId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error; // Re-throw to trigger retry mechanism
    }
  }

  @OnWorkerEvent("completed")
  onCompleted(job: Job<ReferralJobData>): void {
    const duration = job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : "N/A";
    this.logger.log(`Job completed: ${job.name} [${job.id}] - Duration: ${duration}ms`, {
      bookingId: job.data.bookingId,
    });
  }

  @OnWorkerEvent("failed")
  onFailed(job: Job<ReferralJobData> | undefined, error: Error): void {
    if (!job) {
      this.logger.error("Job failed with no job context", { error: error.message });
      return;
    }

    this.logger.error(`Job failed: ${job.name} [${job.id}]`, {
      bookingId: job.data.bookingId,
      error: error.message,
      stack: error.stack,
      attempts: job.attemptsMade,
      maxAttempts: job.opts.attempts,
    });
  }

  @OnWorkerEvent("active")
  onActive(job: Job<ReferralJobData>): void {
    this.logger.log(`Job started: ${job.name} [${job.id}] - Attempt ${job.attemptsMade + 1}`, {
      bookingId: job.data.bookingId,
    });
  }

  @OnWorkerEvent("stalled")
  onStalled(jobId: string): void {
    this.logger.warn(`Job stalled: ${jobId}`);
  }

  @OnWorkerEvent("progress")
  onProgress(job: Job<ReferralJobData>, progress: number | object): void {
    this.logger.debug(`Job progress: ${job.name} [${job.id}]`, {
      bookingId: job.data.bookingId,
      progress,
    });
  }
}
