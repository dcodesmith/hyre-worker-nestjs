import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { Job } from "bullmq";
import { CREATE_FLIGHT_ALERT_JOB, FLIGHT_ALERTS_QUEUE } from "../../config/constants";
import { FlightAwareService } from "./flightaware.service";
import type { FlightAlertJobData } from "./flightaware-alert.interface";

@Processor(FLIGHT_ALERTS_QUEUE)
export class FlightAlertProcessor extends WorkerHost {
  private readonly logger = new Logger(FlightAlertProcessor.name);

  constructor(private readonly flightAwareService: FlightAwareService) {
    super();
  }

  async process(job: Job<FlightAlertJobData, void, string>): Promise<{ success: boolean }> {
    this.logger.log(`Processing flight alert job: ${job.name}`, {
      jobId: job.id,
      flightId: job.data.flightId,
      flightNumber: job.data.flightNumber,
    });

    try {
      if (job.name === CREATE_FLIGHT_ALERT_JOB) {
        const alertId = await this.flightAwareService.getOrCreateFlightAlert(job.data.flightId, {
          flightNumber: job.data.flightNumber,
          flightDate: new Date(job.data.flightDate),
          destinationIATA: job.data.destinationIATA,
        });

        this.logger.log("Flight alert created successfully", {
          flightId: job.data.flightId,
          alertId,
        });

        return { success: true };
      }

      throw new Error(`Unknown flight alert job type: ${job.name}`);
    } catch (error) {
      this.logger.error(`Failed to process ${job.name} job:`, {
        jobId: job.id,
        flightId: job.data.flightId,
        flightNumber: job.data.flightNumber,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error; // Re-throw to trigger retry mechanism
    }
  }

  @OnWorkerEvent("completed")
  onCompleted(job: Job<FlightAlertJobData>): void {
    const duration = job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : "N/A";
    this.logger.log(`Job completed: ${job.name} [${job.id}] - Duration: ${duration}ms`, {
      flightId: job.data.flightId,
    });
  }

  @OnWorkerEvent("failed")
  onFailed(job: Job<FlightAlertJobData> | undefined, error: Error): void {
    if (!job) {
      this.logger.error("Job failed with no job context", { error: error.message });
      return;
    }

    this.logger.error(`Job failed: ${job.name} [${job.id}]`, {
      flightId: job.data.flightId,
      flightNumber: job.data.flightNumber,
      error: error.message,
      stack: error.stack,
      attempts: job.attemptsMade,
      maxAttempts: job.opts.attempts,
    });
  }

  @OnWorkerEvent("active")
  onActive(job: Job<FlightAlertJobData>): void {
    this.logger.log(`Job started: ${job.name} [${job.id}] - Attempt ${job.attemptsMade + 1}`, {
      flightId: job.data.flightId,
    });
  }

  @OnWorkerEvent("stalled")
  onStalled(jobId: string): void {
    this.logger.warn(`Job stalled: ${jobId}`);
  }

  @OnWorkerEvent("progress")
  onProgress(job: Job<FlightAlertJobData>, progress: number | object): void {
    this.logger.debug(`Job progress: ${job.name} [${job.id}]`, {
      flightId: job.data.flightId,
      progress,
    });
  }
}
