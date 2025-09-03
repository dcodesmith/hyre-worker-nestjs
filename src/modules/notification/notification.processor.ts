import { Process, Processor } from "@nestjs/bull";
import { Logger } from "@nestjs/common";
import { Job } from "bull";
import { renderBookingReminderEmail, renderBookingStatusUpdateEmail } from "../../templates/emails";
import { EmailService } from "./email.service";
import {
  NotificationChannel,
  NotificationJobData,
  NotificationResult,
  NotificationType,
} from "./notification.types";
import {
  type TemplateData,
  isBookingStatusTemplateData,
  isBookingReminderTemplateData,
} from "./template-data.types";
import {
  BookingReminderEndMapper,
  BookingReminderStartMapper,
  BookingStatusMapper,
  FallbackTemplateMapper,
  type TemplateVariableMapper,
} from "./template-mappers";
import { Template, WhatsAppService } from "./whatsapp.service";

@Processor("notifications")
export class NotificationProcessor {
  private readonly logger = new Logger(NotificationProcessor.name);
  private readonly templateMappers: TemplateVariableMapper[];

  constructor(
    private readonly emailService: EmailService,
    private readonly whatsAppService: WhatsAppService,
  ) {
    // Initialize template mappers in order of specificity
    this.templateMappers = [
      new BookingStatusMapper(),
      new BookingReminderStartMapper(),
      new BookingReminderEndMapper(),
      new FallbackTemplateMapper(), // Always last as it handles any type
    ];
  }

  @Process({
    name: "send-notification",
    concurrency: 5, // Process 5 notifications concurrently
  })
  async processNotification(job: Job<NotificationJobData>): Promise<NotificationResult[]> {
    const { id, type, channels, recipients, templateData } = job.data;

    this.logger.log("Processing notification", {
      notificationId: id,
      type,
      channels,
      bookingId: job.data.bookingId,
    });

    const results: NotificationResult[] = [];

    // Process each channel
    for (const channel of channels) {
      try {
        if (channel === NotificationChannel.EMAIL) {
          const emailResult = await this.sendEmailNotification(type, recipients, templateData);
          if (emailResult) results.push(emailResult);
        }

        if (channel === NotificationChannel.WHATSAPP) {
          const whatsAppResult = await this.sendWhatsAppNotification(
            type,
            recipients,
            templateData,
          );
          if (whatsAppResult) results.push(whatsAppResult);
        }
      } catch (error) {
        this.logger.error("Failed to process notification channel", {
          notificationId: id,
          channel,
          error: String(error),
        });

        results.push({
          channel,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const { success: successCount, failure: failureCount } = results.reduce(
      (acc, result) => ({
        success: acc.success + (result.success ? 1 : 0),
        failure: acc.failure + (result.success ? 0 : 1),
      }),
      { success: 0, failure: 0 },
    );

    this.logger.log("Notification processing complete", {
      notificationId: id,
      totalChannels: channels.length,
      successful: successCount,
      failed: failureCount,
    });

    return results;
  }

  private async sendEmailNotification(
    type: NotificationType,
    recipients: NotificationJobData["recipients"],
    templateData: TemplateData,
  ): Promise<NotificationResult | null> {
    const customerEmail = recipients.customer?.email;
    const chauffeurEmail = recipients.chauffeur?.email;

    if (!customerEmail && !chauffeurEmail) {
      return null;
    }

    try {
      // Generate HTML content based on notification type
      let html: string;
      const subject: string = templateData.subject || "Booking Notification";

      switch (type) {
        case NotificationType.BOOKING_STATUS_CHANGE:
          if (isBookingStatusTemplateData(templateData)) {
            html = await renderBookingStatusUpdateEmail(templateData);
          } else {
            throw new Error("Invalid template data for booking status update");
          }
          break;
        case NotificationType.BOOKING_REMINDER_START:
        case NotificationType.BOOKING_REMINDER_END:
          if (isBookingReminderTemplateData(templateData)) {
            const recipientType =
              templateData.recipientType === "chauffeur" ? "chauffeur" : "client";
            html = await renderBookingReminderEmail(
              templateData,
              recipientType,
              type === NotificationType.BOOKING_REMINDER_END,
            );
          } else {
            throw new Error("Invalid template data for booking reminder");
          }
          break;
        default:
          throw new Error(`Unknown notification type: ${type}`);
      }

      // Send to customer if available
      if (customerEmail) {
        await this.emailService.sendEmail({
          to: customerEmail,
          subject,
          html,
        });
      }

      // Send to chauffeur if available
      if (chauffeurEmail) {
        await this.emailService.sendEmail({
          to: chauffeurEmail,
          subject,
          html,
        });
      }

      return {
        channel: NotificationChannel.EMAIL,
        success: true,
        messageId: "email-sent",
      };
    } catch (error) {
      this.logger.error("Failed to send email notification", {
        type,
        error: String(error),
      });

      return {
        channel: NotificationChannel.EMAIL,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async sendWhatsAppNotification(
    type: NotificationType,
    recipients: NotificationJobData["recipients"],
    templateData: TemplateData,
  ): Promise<NotificationResult | null> {
    const customerPhone = recipients.customer?.phoneNumber;
    const chauffeurPhone = recipients.chauffeur?.phoneNumber;

    if (!customerPhone && !chauffeurPhone) {
      return null;
    }

    try {
      // Variables will be built per recipient type below

      // Send to customer if available
      if (customerPhone) {
        const customerTemplateKey = this.getWhatsAppTemplateKey(type, "client");
        if (customerTemplateKey) {
          const customerVariables = this.buildWhatsAppVariables(templateData, type, "client");
          await this.whatsAppService.sendMessage({
            to: customerPhone,
            variables: customerVariables,
            templateKey: customerTemplateKey,
          });
        }
      }

      // Send to chauffeur if available
      if (chauffeurPhone) {
        const chauffeurTemplateKey = this.getWhatsAppTemplateKey(type, "chauffeur");
        if (chauffeurTemplateKey) {
          const chauffeurVariables = this.buildWhatsAppVariables(templateData, type, "chauffeur");
          await this.whatsAppService.sendMessage({
            to: chauffeurPhone,
            variables: chauffeurVariables,
            templateKey: chauffeurTemplateKey,
          });
        }
      }

      return {
        channel: NotificationChannel.WHATSAPP,
        success: true,
        messageId: "whatsapp-sent",
      };
    } catch (error) {
      this.logger.error("Failed to send WhatsApp notification", {
        type,
        error: String(error),
      });

      return {
        channel: NotificationChannel.WHATSAPP,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private getWhatsAppTemplateKey(type: NotificationType, recipientType: string): Template | null {
    const mapper = this.templateMappers.find((mapper) => mapper.canHandle(type));
    return mapper?.getTemplateKey(type, recipientType) || null;
  }

  private buildWhatsAppVariables(
    templateData: TemplateData,
    type: NotificationType,
    recipientType: string,
  ): Record<string, string | number> {
    const mapper = this.templateMappers.find((mapper) => mapper.canHandle(type));
    return mapper?.mapVariables(templateData, recipientType) || {};
  }
}
