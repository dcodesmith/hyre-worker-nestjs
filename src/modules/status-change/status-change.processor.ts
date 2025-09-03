import { Process, Processor } from "@nestjs/bull";
import { Logger } from "@nestjs/common";
import { Job } from "bull";
import { StatusChangeService } from "./status-change.service";

interface StatusUpdateJobData {
  type: "confirmed-to-active" | "active-to-completed";
  timestamp: string;
}

@Processor("status-updates")
export class StatusChangeProcessor {
  private readonly logger = new Logger(StatusChangeProcessor.name);

  constructor(private readonly statusChangeService: StatusChangeService) {}

  @Process("confirmed-to-active")
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

  @Process("active-to-completed")
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
