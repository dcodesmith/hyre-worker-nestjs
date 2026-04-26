import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { Job } from "bullmq";
import { z } from "zod";
import {
  ACTIVATE_AIRPORT_BOOKING,
  ACTIVE_TO_COMPLETED,
  CONFIRMED_TO_ACTIVE,
  STATUS_UPDATES_QUEUE,
} from "../../config/constants";
import {
  InvalidStatusUpdateJobPayloadException,
  StatusChangeException,
  StatusUpdateJobProcessingFailedException,
  UnknownStatusUpdateJobTypeException,
} from "./status-change.error";
import { StatusUpdateJobData } from "./status-change.interface";
import { StatusChangeService } from "./status-change.service";

const dateTimeString = z
  .string()
  .refine((value) => !Number.isNaN(new Date(value).getTime()), "Invalid datetime");

const statusUpdateJobDataSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal(CONFIRMED_TO_ACTIVE),
    timestamp: dateTimeString.optional(),
  }),
  z.object({
    type: z.literal(ACTIVE_TO_COMPLETED),
    timestamp: dateTimeString.optional(),
  }),
  z.object({
    type: z.literal(ACTIVATE_AIRPORT_BOOKING),
    bookingId: z.string().trim().min(1),
    activationAt: dateTimeString.optional(),
  }),
]);

@Processor(STATUS_UPDATES_QUEUE)
export class StatusChangeProcessor extends WorkerHost {
  private readonly logger = new Logger(StatusChangeProcessor.name);

  constructor(private readonly statusChangeService: StatusChangeService) {
    super();
  }

  async process(job: Job<StatusUpdateJobData, { success: boolean; result?: string }, string>) {
    this.logger.log(`Processing status update job: ${job.name}`, job.data);

    try {
      let result: string | undefined;
      if (
        ![CONFIRMED_TO_ACTIVE, ACTIVE_TO_COMPLETED, ACTIVATE_AIRPORT_BOOKING].includes(job.name)
      ) {
        throw new UnknownStatusUpdateJobTypeException(job.name);
      }

      const parsed = statusUpdateJobDataSchema.safeParse(job.data);
      if (!parsed.success) {
        throw new InvalidStatusUpdateJobPayloadException(job.name);
      }
      const jobData = parsed.data;

      if (job.name !== jobData.type) {
        throw new InvalidStatusUpdateJobPayloadException(job.name);
      }

      switch (jobData.type) {
        case CONFIRMED_TO_ACTIVE: {
          result = await this.statusChangeService.updateBookingsFromConfirmedToActive(
            jobData.timestamp,
          );
          this.logger.log(`Confirmed to active updates processed: ${result}`);
          break;
        }
        case ACTIVE_TO_COMPLETED: {
          result = await this.statusChangeService.updateBookingsFromActiveToCompleted(
            jobData.timestamp,
          );
          this.logger.log(`Active to completed updates processed: ${result}`);
          break;
        }
        case ACTIVATE_AIRPORT_BOOKING: {
          result = await this.statusChangeService.activateAirportBooking(
            jobData.bookingId,
            jobData.activationAt,
          );
          this.logger.log(`Airport booking activation processed: ${result}`);
          break;
        }
      }

      return { success: true, result };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const wrappedError =
        error instanceof StatusChangeException
          ? error
          : new StatusUpdateJobProcessingFailedException(job.name, reason);
      this.logger.error(`Failed to process ${job.name} job:`, error);
      throw wrappedError;
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
