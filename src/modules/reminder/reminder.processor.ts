import { Process, Processor } from "@nestjs/bull";
import { Logger } from "@nestjs/common";
import { Job } from "bull";
import { ReminderService } from "./reminder.service";

interface ReminderJobData {
  type: "trip-start" | "trip-end";
  timestamp: string;
}

@Processor("reminder-emails")
export class ReminderProcessor {
  private readonly logger = new Logger(ReminderProcessor.name);

  constructor(private readonly reminderService: ReminderService) {}

  @Process("booking-leg-start-reminder")
  async processStartReminder(job: Job<ReminderJobData>) {
    this.logger.log("Processing booking start reminder job:", job.data);

    try {
      const result = await this.reminderService.sendBookingStartReminderEmails();
      this.logger.log("Booking start reminders processed:", result);
      return { success: true, result };
    } catch (error) {
      this.logger.error("Failed to process start reminder job:", error);
      throw error;
    }
  }

  @Process("booking-leg-end-reminder")
  async processEndReminder(job: Job<ReminderJobData>) {
    this.logger.log("Processing booking end reminder job:", job.data);

    try {
      const result = await this.reminderService.sendBookingEndReminderEmails();
      this.logger.log("Booking end reminders processed:", result);
      return { success: true, result };
    } catch (error) {
      this.logger.error("Failed to process end reminder job:", error);
      throw error;
    }
  }
}
