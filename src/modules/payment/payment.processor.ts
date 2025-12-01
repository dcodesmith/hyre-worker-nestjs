import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import { Job } from "bullmq";
import { PAYOUTS_QUEUE } from "../../config/constants";
import { DatabaseService } from "../database/database.service";
import { PayoutJobData, PROCESS_PAYOUT_FOR_BOOKING } from "./payment.interface";
import { PaymentService } from "./payment.service";

@Processor(PAYOUTS_QUEUE)
@Injectable()
export class PaymentProcessor extends WorkerHost {
  private readonly logger = new Logger(PaymentProcessor.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly paymentService: PaymentService,
  ) {
    super();
  }

  async process(job: Job<PayoutJobData, any, string>) {
    this.logger.log(`Processing payout job: ${job.name}`, job.data);

    if (job.name !== PROCESS_PAYOUT_FOR_BOOKING) {
      throw new Error(`Unknown payout job type: ${job.name}`);
    }

    const { bookingId } = job.data;

    try {
      const booking = await this.databaseService.booking.findUnique({
        where: { id: bookingId },
        include: {
          chauffeur: true,
          user: true,
          car: { include: { owner: true } },
          legs: {
            include: {
              extensions: true,
            },
          },
        },
      });

      if (!booking) {
        this.logger.warn(`Booking ${bookingId} not found when processing payout job`);
        return { success: false, reason: "BOOKING_NOT_FOUND" };
      }

      if (booking.status !== "COMPLETED") {
        this.logger.warn(`Booking ${bookingId} is not in COMPLETED status, skipping payout`, {
          bookingId,
          currentStatus: booking.status,
        });
        return { success: false, reason: "INVALID_BOOKING_STATUS" };
      }

      await this.paymentService.initiatePayout(booking);

      return { success: true };
    } catch (error) {
      this.logger.error(
        `Failed to process payout for booking ${bookingId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw error;
    }
  }

  @OnWorkerEvent("completed")
  onCompleted(job: Job<PayoutJobData>) {
    const duration = job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : "N/A";
    this.logger.log(`Payout job completed: ${job.name} [${job.id}] - Duration: ${duration}ms`);
  }

  @OnWorkerEvent("failed")
  onFailed(job: Job<PayoutJobData>, error: Error) {
    this.logger.error(`Payout job failed: ${job.name} [${job.id}]`, {
      error: error.message,
      stack: error.stack,
      attempts: job.attemptsMade,
      maxAttempts: job.opts.attempts,
    });
  }

  @OnWorkerEvent("active")
  onActive(job: Job<PayoutJobData>) {
    this.logger.log(
      `Payout job started: ${job.name} [${job.id}] - Attempt ${job.attemptsMade + 1}`,
    );
  }

  @OnWorkerEvent("stalled")
  onStalled(jobId: string) {
    this.logger.warn(`Payout job stalled: ${jobId}`);
  }

  @OnWorkerEvent("progress")
  onProgress(job: Job<PayoutJobData>, progress: number | object) {
    this.logger.debug(`Payout job progress: ${job.name} [${job.id}]`, progress);
  }
}
