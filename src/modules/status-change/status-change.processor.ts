import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject } from "@nestjs/common";
import { Job } from "bullmq";
import { PinoLogger } from "nestjs-pino";
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
  constructor(
    private readonly statusChangeService: StatusChangeService,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {
    super();
    this.logger.setContext(StatusChangeProcessor.name);
  }

  async process(job: Job<StatusUpdateJobData, { success: boolean; result?: string }, string>) {
    this.logger.info({ jobName: job.name, jobData: job.data }, "Processing status update job");

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
          this.logger.info({ result }, "Confirmed to active updates processed");
          break;
        }
        case ACTIVE_TO_COMPLETED: {
          result = await this.statusChangeService.updateBookingsFromActiveToCompleted(
            jobData.timestamp,
          );
          this.logger.info({ result }, "Active to completed updates processed");
          break;
        }
        case ACTIVATE_AIRPORT_BOOKING: {
          result = await this.statusChangeService.activateAirportBooking(
            jobData.bookingId,
            jobData.activationAt,
          );
          this.logger.info({ result }, "Airport booking activation processed");
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
      this.logger.error(
        {
          jobName: job.name,
          error: wrappedError.message,
          stack: wrappedError instanceof Error ? wrappedError.stack : undefined,
        },
        "Failed to process status update job",
      );
      throw wrappedError;
    }
  }

  @OnWorkerEvent("completed")
  onCompleted(job: Job<StatusUpdateJobData>) {
    const duration = job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : "N/A";
    this.logger.info({ jobName: job.name, jobId: job.id, durationMs: duration }, "Job completed");
  }

  @OnWorkerEvent("failed")
  onFailed(job: Job<StatusUpdateJobData>, error: Error) {
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
  onActive(job: Job<StatusUpdateJobData>) {
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
  onProgress(job: Job<StatusUpdateJobData>, progress: number | object) {
    this.logger.debug({ jobName: job.name, jobId: job.id, progress }, "Job progress");
  }
}
