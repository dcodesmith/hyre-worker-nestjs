import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject } from "@nestjs/common";
import { Job } from "bullmq";
import { PinoLogger } from "nestjs-pino";
import { CREATE_FLIGHT_ALERT_JOB, FLIGHT_ALERTS_QUEUE } from "../../config/constants";
import type { FlightAlertJobData } from "./flightaware-alert.interface";
import { FlightAwareAlertService } from "./flightaware-alert.service";

@Processor(FLIGHT_ALERTS_QUEUE)
export class FlightAlertProcessor extends WorkerHost {
  constructor(
    private readonly flightAwareAlertService: FlightAwareAlertService,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {
    super();
    this.logger.setContext(FlightAlertProcessor.name);
  }

  async process(job: Job<FlightAlertJobData, void, string>): Promise<{ success: boolean }> {
    this.logger.info(
      {
        jobName: job.name,
        jobId: job.id,
        flightId: job.data.flightId,
        flightNumber: job.data.flightNumber,
      },
      "Processing flight alert job",
    );

    try {
      if (job.name === CREATE_FLIGHT_ALERT_JOB) {
        const alertId = await this.flightAwareAlertService.getOrCreateFlightAlert(
          job.data.flightId,
          {
            flightNumber: job.data.flightNumber,
            flightDate: new Date(job.data.flightDate),
            destinationIATA: job.data.destinationIATA,
          },
        );

        this.logger.info(
          { flightId: job.data.flightId, alertId },
          "Flight alert created successfully",
        );

        return { success: true };
      }

      throw new Error(`Unknown flight alert job type: ${job.name}`);
    } catch (error) {
      this.logger.error(
        {
          jobName: job.name,
          jobId: job.id,
          flightId: job.data.flightId,
          flightNumber: job.data.flightNumber,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        "Failed to process flight alert job",
      );
      throw error; // Re-throw to trigger retry mechanism
    }
  }

  @OnWorkerEvent("completed")
  onCompleted(job: Job<FlightAlertJobData>): void {
    const duration = job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : "N/A";
    this.logger.info(
      { jobName: job.name, jobId: job.id, durationMs: duration, flightId: job.data.flightId },
      "Job completed",
    );
  }

  @OnWorkerEvent("failed")
  onFailed(job: Job<FlightAlertJobData> | undefined, error: Error): void {
    if (!job) {
      this.logger.error(
        { error: error.message, stack: error.stack },
        "Job failed with no job context",
      );
      return;
    }

    this.logger.error(
      {
        jobName: job.name,
        jobId: job.id,
        flightId: job.data.flightId,
        flightNumber: job.data.flightNumber,
        error: error.message,
        stack: error.stack,
        attempts: job.attemptsMade,
        maxAttempts: job.opts.attempts,
      },
      "Job failed",
    );
  }

  @OnWorkerEvent("active")
  onActive(job: Job<FlightAlertJobData>): void {
    this.logger.info(
      {
        jobName: job.name,
        jobId: job.id,
        attempt: job.attemptsMade + 1,
        flightId: job.data.flightId,
      },
      "Job started",
    );
  }

  @OnWorkerEvent("stalled")
  onStalled(jobId: string): void {
    this.logger.warn({ jobId }, "Job stalled");
  }

  @OnWorkerEvent("progress")
  onProgress(job: Job<FlightAlertJobData>, progress: number | object): void {
    this.logger.debug(
      { jobName: job.name, jobId: job.id, flightId: job.data.flightId, progress },
      "Job progress",
    );
  }
}
