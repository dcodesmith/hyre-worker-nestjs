import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { Job } from "bullmq";
import { NOTIFICATIONS_QUEUE } from "../../config/constants";
import {
  renderBookingConfirmationEmail,
  renderBookingReminderEmail,
  renderBookingStatusUpdateEmail,
  renderFleetOwnerNewBookingEmail,
  renderReviewReceivedEmailForChauffeur,
  renderReviewReceivedEmailForOwner,
} from "../../templates/emails";
import { EmailService } from "./email.service";
import {
  CHAUFFEUR_RECIPIENT_TYPE,
  CLIENT_RECIPIENT_TYPE,
  FLEET_OWNER_RECIPIENT_TYPE,
} from "./notification.const";
import {
  NotificationChannel,
  NotificationJobData,
  NotificationRecipientResult,
  NotificationResult,
  NotificationType,
} from "./notification.interface";
import {
  BOOKING_CONFIRMED_TEMPLATE_KIND,
  BOOKING_REMINDER_TEMPLATE_KIND,
  BOOKING_STATUS_TEMPLATE_KIND,
  FLEET_OWNER_NEW_BOOKING_TEMPLATE_KIND,
  REVIEW_RECEIVED_TEMPLATE_KIND,
  RecipientType,
  type ReviewReceivedTemplateData,
  type TemplateData,
} from "./template-data.interface";
import {
  BookingConfirmedMapper,
  BookingReminderEndMapper,
  BookingReminderStartMapper,
  BookingStatusMapper,
  FallbackTemplateMapper,
  FleetOwnerNewBookingMapper,
  type TemplateVariableMapper,
} from "./template-mappers";
import { Template, WhatsAppService } from "./whatsapp.service";

@Processor(NOTIFICATIONS_QUEUE, {
  concurrency: 5,
})
export class NotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationProcessor.name);
  private readonly templateMappers: TemplateVariableMapper[];

  constructor(
    private readonly emailService: EmailService,
    private readonly whatsAppService: WhatsAppService,
  ) {
    super();
    // Initialize template mappers in order of specificity
    this.templateMappers = [
      new BookingConfirmedMapper(),
      new FleetOwnerNewBookingMapper(),
      new BookingStatusMapper(),
      new BookingReminderStartMapper(),
      new BookingReminderEndMapper(),
      new FallbackTemplateMapper(), // Always last as it handles any type
    ];
  }

  async process(
    job: Job<NotificationJobData, NotificationResult[], string>,
  ): Promise<NotificationResult[]> {
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
      const result = await this.processChannel(id, channel, type, recipients, templateData);
      if (result) results.push(result);
    }

    this.logProcessingComplete(id, channels, results);
    return results;
  }

  private async processChannel(
    notificationId: string,
    channel: NotificationChannel,
    type: NotificationType,
    recipients: NotificationJobData["recipients"],
    templateData: TemplateData,
  ): Promise<NotificationResult | null> {
    try {
      if (channel === NotificationChannel.EMAIL) {
        return await this.sendEmailNotification(type, recipients, templateData);
      }

      if (channel === NotificationChannel.WHATSAPP) {
        return await this.sendWhatsAppNotification(type, recipients, templateData);
      }

      return null;
    } catch (error) {
      this.logger.error("Failed to process notification channel", {
        notificationId,
        channel,
        error: String(error),
      });

      return {
        channel,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private logProcessingComplete(
    notificationId: string,
    channels: NotificationChannel[],
    results: NotificationResult[],
  ): void {
    const { success: successCount, failure: failureCount } = results.reduce(
      (acc, result) => ({
        success: acc.success + (result.success ? 1 : 0),
        failure: acc.failure + (result.success ? 0 : 1),
      }),
      { success: 0, failure: 0 },
    );

    const skipped = channels.length - results.length;

    this.logger.log("Notification processing complete", {
      notificationId,
      totalChannels: channels.length,
      successful: successCount,
      failed: failureCount,
      skipped,
    });
  }

  private async sendEmailNotification(
    type: NotificationType,
    recipients: NotificationJobData["recipients"],
    templateData: TemplateData,
  ): Promise<NotificationResult | null> {
    const clientRecipient = recipients[CLIENT_RECIPIENT_TYPE];
    const chauffeurRecipient = recipients[CHAUFFEUR_RECIPIENT_TYPE];
    const fleetOwnerRecipient = recipients[FLEET_OWNER_RECIPIENT_TYPE];
    const clientEmail = clientRecipient?.email;
    const chauffeurEmail = chauffeurRecipient?.email;
    const fleetOwnerEmail = fleetOwnerRecipient?.email;

    if (!clientEmail && !chauffeurEmail && !fleetOwnerEmail) {
      return null;
    }

    try {
      const subject = templateData.subject;
      const recipientEmails: Array<{ recipient: RecipientType; email?: string }> = [
        { recipient: CLIENT_RECIPIENT_TYPE, email: clientEmail },
        { recipient: CHAUFFEUR_RECIPIENT_TYPE, email: chauffeurEmail },
        { recipient: FLEET_OWNER_RECIPIENT_TYPE, email: fleetOwnerEmail },
      ];
      const perRecipientResults: NotificationRecipientResult[] = [];

      for (const { recipient, email } of recipientEmails) {
        if (!email) continue;

        try {
          const html = await this.buildEmailHtml(type, templateData, recipient);
          const sendResult = await this.emailService.sendEmail({
            to: email,
            subject,
            html,
          });

          perRecipientResults.push({
            recipient,
            email,
            success: true,
            messageId: sendResult.data?.id,
          });
        } catch (error) {
          perRecipientResults.push({
            recipient,
            email,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const success = perRecipientResults.every((result) => result.success);
      return {
        channel: NotificationChannel.EMAIL,
        success,
        messageId: success ? "email-sent" : undefined,
        error: success ? undefined : "One or more email recipients failed",
        perRecipientResults,
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

  private buildEmailHtml(
    type: NotificationType,
    templateData: TemplateData,
    recipient: RecipientType,
  ): Promise<string> {
    switch (type) {
      case NotificationType.BOOKING_CONFIRMED:
        return this.buildBookingConfirmedEmailHtml(templateData);
      case NotificationType.FLEET_OWNER_NEW_BOOKING:
        return this.buildFleetOwnerNewBookingEmailHtml(templateData);
      case NotificationType.BOOKING_STATUS_CHANGE:
        return this.buildBookingStatusEmailHtml(templateData);
      case NotificationType.BOOKING_REMINDER_START:
      case NotificationType.BOOKING_REMINDER_END:
        return this.buildBookingReminderEmailHtml(type, templateData, recipient);
      case NotificationType.REVIEW_RECEIVED:
        return this.buildReviewReceivedEmailHtml(templateData, recipient);
      default:
        throw new Error(`Unknown notification type: ${type}`);
    }
  }

  private buildBookingConfirmedEmailHtml(templateData: TemplateData): Promise<string> {
    if (templateData.templateKind !== BOOKING_CONFIRMED_TEMPLATE_KIND) {
      throw new Error("Invalid template data for booking confirmation");
    }
    return renderBookingConfirmationEmail(templateData);
  }

  private buildFleetOwnerNewBookingEmailHtml(templateData: TemplateData): Promise<string> {
    if (templateData.templateKind !== FLEET_OWNER_NEW_BOOKING_TEMPLATE_KIND) {
      throw new Error("Invalid template data for fleet owner booking notification");
    }
    return renderFleetOwnerNewBookingEmail(templateData);
  }

  private buildBookingStatusEmailHtml(templateData: TemplateData): Promise<string> {
    if (templateData.templateKind !== BOOKING_STATUS_TEMPLATE_KIND) {
      throw new Error("Invalid template data for booking status update");
    }
    // Status email currently targets the client. If chauffeur delivery is desired,
    // a recipient-specific template should be introduced.
    return renderBookingStatusUpdateEmail(templateData);
  }

  private buildBookingReminderEmailHtml(
    type: NotificationType,
    templateData: TemplateData,
    recipient: RecipientType,
  ): Promise<string> {
    if (templateData.templateKind !== BOOKING_REMINDER_TEMPLATE_KIND) {
      throw new Error("Invalid template data for booking reminder");
    }
    if (recipient !== CLIENT_RECIPIENT_TYPE && recipient !== CHAUFFEUR_RECIPIENT_TYPE) {
      throw new Error(`Booking reminders cannot be sent to recipient type: ${recipient}`);
    }
    return renderBookingReminderEmail(
      templateData,
      recipient,
      type === NotificationType.BOOKING_REMINDER_START,
    );
  }

  private buildReviewReceivedEmailHtml(
    templateData: TemplateData,
    recipient: RecipientType,
  ): Promise<string> {
    if (templateData.templateKind !== REVIEW_RECEIVED_TEMPLATE_KIND) {
      throw new Error("Invalid template data for review received");
    }
    const normalizedTemplateData = this.normalizeReviewReceivedTemplateData(templateData);

    if (recipient === FLEET_OWNER_RECIPIENT_TYPE) {
      return renderReviewReceivedEmailForOwner(
        normalizedTemplateData.ownerName || "Fleet Owner",
        normalizedTemplateData,
      );
    }

    if (recipient === CHAUFFEUR_RECIPIENT_TYPE) {
      return renderReviewReceivedEmailForChauffeur(
        normalizedTemplateData.chauffeurName || "Chauffeur",
        normalizedTemplateData,
      );
    }

    throw new Error(`Review notifications cannot be sent to recipient type: ${recipient}`);
  }

  private normalizeReviewReceivedTemplateData(
    templateData: ReviewReceivedTemplateData,
  ): ReviewReceivedTemplateData & { reviewDate: Date } {
    return {
      ...templateData,
      reviewDate: this.normalizeReviewDate(templateData.reviewDate),
    };
  }

  private normalizeReviewDate(reviewDate: string | Date): Date {
    if (reviewDate instanceof Date) {
      return reviewDate;
    }

    const parsedDate = new Date(reviewDate);
    if (Number.isNaN(parsedDate.getTime())) {
      throw new TypeError("Invalid review date in review notification payload");
    }

    return parsedDate;
  }

  private async sendWhatsAppNotification(
    type: NotificationType,
    recipients: NotificationJobData["recipients"],
    templateData: TemplateData,
  ): Promise<NotificationResult | null> {
    const clientRecipient = recipients[CLIENT_RECIPIENT_TYPE];
    const chauffeurRecipient = recipients[CHAUFFEUR_RECIPIENT_TYPE];
    const fleetOwnerRecipient = recipients[FLEET_OWNER_RECIPIENT_TYPE];
    const clientPhone = clientRecipient?.phoneNumber;
    const chauffeurPhone = chauffeurRecipient?.phoneNumber;
    const fleetOwnerPhone = fleetOwnerRecipient?.phoneNumber;

    if (!clientPhone && !chauffeurPhone && !fleetOwnerPhone) {
      return null;
    }

    try {
      // Variables will be built per recipient type below

      // Send to customer if available
      if (clientPhone) {
        const clientTemplateKey = this.getWhatsAppTemplateKey(type, CLIENT_RECIPIENT_TYPE);
        if (clientTemplateKey) {
          const clientVariables = this.buildWhatsAppVariables(
            templateData,
            type,
            CLIENT_RECIPIENT_TYPE,
          );
          await this.whatsAppService.sendMessage({
            to: clientPhone,
            variables: clientVariables,
            templateKey: clientTemplateKey,
          });
        }
      }

      // Send to chauffeur if available
      if (chauffeurPhone) {
        const chauffeurTemplateKey = this.getWhatsAppTemplateKey(type, CHAUFFEUR_RECIPIENT_TYPE);
        if (chauffeurTemplateKey) {
          const chauffeurVariables = this.buildWhatsAppVariables(
            templateData,
            type,
            CHAUFFEUR_RECIPIENT_TYPE,
          );
          await this.whatsAppService.sendMessage({
            to: chauffeurPhone,
            variables: chauffeurVariables,
            templateKey: chauffeurTemplateKey,
          });
        }
      }

      // Send to fleet owner if available
      if (fleetOwnerPhone) {
        const fleetOwnerTemplateKey = this.getWhatsAppTemplateKey(type, FLEET_OWNER_RECIPIENT_TYPE);
        if (fleetOwnerTemplateKey) {
          const fleetOwnerVariables = this.buildWhatsAppVariables(
            templateData,
            type,
            FLEET_OWNER_RECIPIENT_TYPE,
          );
          await this.whatsAppService.sendMessage({
            to: fleetOwnerPhone,
            variables: fleetOwnerVariables,
            templateKey: fleetOwnerTemplateKey,
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

  private getWhatsAppTemplateKey(
    type: NotificationType,
    recipientType: RecipientType,
  ): Template | null {
    const mapper = this.templateMappers.find((mapper) => mapper.canHandle(type));
    return mapper?.getTemplateKey(type, recipientType) || null;
  }

  private buildWhatsAppVariables(
    templateData: TemplateData,
    type: NotificationType,
    recipientType: RecipientType,
  ): Record<string, string | number> {
    const mapper = this.templateMappers.find((mapper) => mapper.canHandle(type));
    return mapper?.mapVariables(templateData, recipientType) || {};
  }

  @OnWorkerEvent("completed")
  onCompleted(job: Job<NotificationJobData, NotificationResult[]>) {
    const duration = job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : "N/A";
    this.logger.log(
      `Notification job completed: ${job.data.type} [${job.id}] - Duration: ${duration}ms`,
    );
  }

  @OnWorkerEvent("failed")
  onFailed(job: Job<NotificationJobData, NotificationResult[]>, error: Error) {
    this.logger.error(`Notification job failed: ${job.data.type} [${job.id}]`, {
      notificationId: job.data.id,
      bookingId: job.data.bookingId,
      channels: job.data.channels,
      error: error.message,
      stack: error.stack,
      attempts: job.attemptsMade,
      maxAttempts: job.opts.attempts,
    });
  }

  @OnWorkerEvent("active")
  onActive(job: Job<NotificationJobData, NotificationResult[]>) {
    this.logger.log(
      `Notification job started: ${job.data.type} [${job.id}] - Attempt ${job.attemptsMade + 1}`,
      {
        notificationId: job.data.id,
        channels: job.data.channels,
      },
    );
  }

  @OnWorkerEvent("stalled")
  onStalled(jobId: string) {
    this.logger.warn(`Notification job stalled: ${jobId}`);
  }

  @OnWorkerEvent("progress")
  onProgress(job: Job<NotificationJobData, NotificationResult[]>, progress: number | object) {
    this.logger.debug(`Notification job progress: ${job.data.type} [${job.id}]`, progress);
  }
}
