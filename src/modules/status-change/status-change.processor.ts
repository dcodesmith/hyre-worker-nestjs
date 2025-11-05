import { Process, Processor } from "@nestjs/bull";
import { Logger } from "@nestjs/common";
import { Job } from "bull";
import {
  ACTIVE_TO_COMPLETED,
  CONFIRMED_TO_ACTIVE,
  STATUS_UPDATES_QUEUE,
} from "../../config/constants";
import { StatusUpdateJobData } from "./status-change.interface";
import { StatusChangeService } from "./status-change.service";

@Processor(STATUS_UPDATES_QUEUE)
export class StatusChangeProcessor {
  private readonly logger = new Logger(StatusChangeProcessor.name);

  constructor(private readonly statusChangeService: StatusChangeService) {}

  @Process(CONFIRMED_TO_ACTIVE)
  async processConfirmedToActive(job: Job<StatusUpdateJobData>) {
    this.logger.log("Processing confirmed to active status update job:", job.data);

    try {
      const result = await this.statusChangeService.updateBookingsFromConfirmedToActive();
      this.logger.log(`Confirmed to active updates processed: ${result}`);
      return { success: true, result };
    } catch (error) {
      this.logger.error("Failed to process confirmed to active job:", error);
      throw error;
    }
  }

  @Process(ACTIVE_TO_COMPLETED)
  async processActiveToCompleted(job: Job<StatusUpdateJobData>) {
    this.logger.log("Processing active to completed status update job:", job.data);

    try {
      const result = await this.statusChangeService.updateBookingsFromActiveToCompleted();
      this.logger.log(`Active to completed updates processed: ${result}`);
      return { success: true, result };
    } catch (error) {
      this.logger.error("Failed to process active to completed job:", error);
      throw error;
    }
  }
}
