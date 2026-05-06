import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject } from "@nestjs/common";
import { Job, UnrecoverableError } from "bullmq";
import { PinoLogger } from "nestjs-pino";
import { NOTIFICATIONS_QUEUE } from "../../config/constants";
import {
  renderBookingConfirmationEmail,
  renderBookingExtensionConfirmationEmail,
  renderBookingReminderEmail,
  renderBookingStatusUpdateEmail,
  renderFleetOwnerBookingCancellationEmail,
  renderFleetOwnerNewBookingEmail,
  renderReviewReceivedEmailForChauffeur,
  renderReviewReceivedEmailForOwner,
  renderUserBookingCancellationEmail,
} from "../../templates/emails";
import { EmailService } from "../email/email.service";
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
import { NotificationDispatchError } from "./notification.processor.error";
import { getSucceededChannels } from "./notification.processor.helper";
import { PushService } from "./push.service";
import { PushTokenService } from "./push-token.service";
import {
  BOOKING_CANCELLED_TEMPLATE_KIND,
  BOOKING_CONFIRMED_TEMPLATE_KIND,
  BOOKING_EXTENSION_CONFIRMED_TEMPLATE_KIND,
  BOOKING_REMINDER_TEMPLATE_KIND,
  BOOKING_STATUS_TEMPLATE_KIND,
  FLEET_OWNER_NEW_BOOKING_TEMPLATE_KIND,
  REVIEW_RECEIVED_TEMPLATE_KIND,
  RecipientType,
  type ReviewReceivedTemplateData,
  type TemplateData,
} from "./template-data.interface";
import {
  BookingCancelledMapper,
  BookingConfirmedMapper,
  BookingExtensionConfirmedMapper,
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
  private readonly templateMappers: TemplateVariableMapper[];

  constructor(
    private readonly emailService: EmailService,
    private readonly whatsAppService: WhatsAppService,
    private readonly pushService: PushService,
    private readonly pushTokenService: PushTokenService,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {
    super();
    this.logger.setContext(NotificationProcessor.name);
    // Initialize template mappers in order of specificity
    this.templateMappers = [
      new BookingConfirmedMapper(),
      new BookingExtensionConfirmedMapper(),
      new BookingCancelledMapper(),
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

    this.logger.info(
      { notificationId: id, type, channels, bookingId: job.data.bookingId },
      "Processing notification",
    );

    const succeededChannels = new Set(getSucceededChannels(job.progress));
    const results: NotificationResult[] = [];

    // Process each channel
    for (const channel of channels) {
      if (succeededChannels.has(channel)) {
        this.logger.info(
          { notificationId: id, channel },
          "Skipping already-succeeded notification channel",
        );
        continue;
      }

      const result = await this.processChannel(
        id,
        channel,
        type,
        recipients,
        templateData,
        job.data.bookingId,
        job.data.pushPayload,
      );
      if (result) results.push(result);
      if (result?.success) {
        succeededChannels.add(channel);
      }
    }

    await job.updateProgress({
      succeededChannels: [...succeededChannels],
    });

    this.logProcessingComplete(id, channels, results);

    const failed = results.filter((result) => !result.success);
    if (failed.length > 0) {
      const dispatchError = new NotificationDispatchError(
        id,
        failed.map((result) => result.channel),
        job.attemptsMade + 1,
        job.opts.attempts,
      );

      if (failed.every((result) => result.retryable === false)) {
        // Stop queue-level retries when all failed channels are non-retryable
        // (e.g. InvalidCredentials).
        throw new UnrecoverableError(dispatchError.message);
      }
      throw dispatchError;
    }

    return results;
  }

  private async processChannel(
    notificationId: string,
    channel: NotificationChannel,
    type: NotificationType,
    recipients: NotificationJobData["recipients"],
    templateData: TemplateData,
    bookingId: string,
    pushPayload: NotificationJobData["pushPayload"],
  ): Promise<NotificationResult | null> {
    try {
      if (channel === NotificationChannel.EMAIL) {
        return await this.sendEmailNotification(type, recipients, templateData);
      }

      if (channel === NotificationChannel.WHATSAPP) {
        return await this.sendWhatsAppNotification(type, recipients, templateData);
      }

      if (channel === NotificationChannel.PUSH) {
        return await this.sendPushNotification(type, recipients, bookingId, pushPayload);
      }

      return null;
    } catch (error) {
      this.logger.error(
        {
          notificationId,
          channel,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to process notification channel",
      );

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

    this.logger.info(
      {
        notificationId,
        totalChannels: channels.length,
        successful: successCount,
        failed: failureCount,
        skipped,
      },
      "Notification processing complete",
    );
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
            channel: NotificationChannel.EMAIL,
            email,
            success: true,
            messageId: sendResult.data?.id,
          });
        } catch (error) {
          perRecipientResults.push({
            recipient,
            channel: NotificationChannel.EMAIL,
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
      this.logger.error(
        { type, error: error instanceof Error ? error.message : String(error) },
        "Failed to send email notification",
      );

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
      case NotificationType.BOOKING_EXTENSION_CONFIRMED:
        return this.buildBookingExtensionConfirmedEmailHtml(templateData);
      case NotificationType.FLEET_OWNER_NEW_BOOKING:
        return this.buildFleetOwnerNewBookingEmailHtml(templateData);
      case NotificationType.BOOKING_CANCELLED:
        return this.buildBookingCancelledEmailHtml(templateData, recipient);
      case NotificationType.BOOKING_STATUS_CHANGE:
      case NotificationType.CHAUFFEUR_ASSIGNED:
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

  private buildBookingExtensionConfirmedEmailHtml(templateData: TemplateData): Promise<string> {
    if (templateData.templateKind !== BOOKING_EXTENSION_CONFIRMED_TEMPLATE_KIND) {
      throw new Error("Invalid template data for booking extension confirmation");
    }
    return renderBookingExtensionConfirmationEmail(templateData);
  }

  private buildBookingStatusEmailHtml(templateData: TemplateData): Promise<string> {
    if (templateData.templateKind !== BOOKING_STATUS_TEMPLATE_KIND) {
      throw new Error("Invalid template data for booking status update");
    }
    // Status email currently targets the client. If chauffeur delivery is desired,
    // a recipient-specific template should be introduced.
    return renderBookingStatusUpdateEmail(templateData);
  }

  private buildBookingCancelledEmailHtml(
    templateData: TemplateData,
    recipient: RecipientType,
  ): Promise<string> {
    if (templateData.templateKind !== BOOKING_CANCELLED_TEMPLATE_KIND) {
      throw new Error("Invalid template data for booking cancellation");
    }

    if (recipient === FLEET_OWNER_RECIPIENT_TYPE) {
      return renderFleetOwnerBookingCancellationEmail(templateData);
    }

    return renderUserBookingCancellationEmail(templateData);
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
      this.logger.error(
        { type, error: error instanceof Error ? error.message : String(error) },
        "Failed to send WhatsApp notification",
      );

      return {
        channel: NotificationChannel.WHATSAPP,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async sendPushNotification(
    type: NotificationType,
    recipients: NotificationJobData["recipients"],
    bookingId: string,
    pushPayload: NotificationJobData["pushPayload"],
  ): Promise<NotificationResult | null> {
    const pushRecipients = Object.entries(recipients).flatMap(([recipientType, recipient]) =>
      (recipient?.pushTokens ?? []).map((token) => ({
        recipient: recipientType as RecipientType,
        pushToken: token,
      })),
    );
    const uniquePushRecipients = Array.from(
      new Map(pushRecipients.map((entry) => [entry.pushToken, entry])).values(),
    );
    const uniqueTokens = uniquePushRecipients.map((entry) => entry.pushToken);
    if (uniqueTokens.length === 0) {
      return null;
    }

    const payload = pushPayload ?? {
      title: "Booking update",
      body:
        type === NotificationType.CHAUFFEUR_ASSIGNED
          ? "Your chauffeur has been assigned."
          : "You have a new update for your booking.",
      data: {
        bookingId,
        type,
      },
    };

    const result = await this.pushService.sendPushNotifications({
      tokens: uniqueTokens,
      title: payload.title,
      body: payload.body,
      data: payload.data,
    });
    const deliveryErrors = result.errors ?? [];

    if (result.invalidTokens.length > 0) {
      try {
        await this.pushTokenService.revokeTokens(result.invalidTokens);
      } catch (error) {
        this.logger.error(
          {
            bookingId,
            type,
            invalidTokenCount: result.invalidTokens.length,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to revoke invalid push tokens after push delivery",
        );
      }
    }

    if (deliveryErrors.length > 0) {
      const retryableErrors = deliveryErrors.filter((error) => error.retryable);
      const nonRetryableErrors = deliveryErrors.filter((error) => !error.retryable);
      const errorCodeCounts = deliveryErrors.reduce<Record<string, number>>((acc, error) => {
        acc[error.code] = (acc[error.code] ?? 0) + 1;
        return acc;
      }, {});

      this.logger.error(
        {
          bookingId,
          type,
          sent: result.sent,
          failed: result.failed,
          invalidTokenCount: result.invalidTokens.length,
          retryableErrorCount: retryableErrors.length,
          nonRetryableErrorCount: nonRetryableErrors.length,
          errorCodeCounts,
          sampleErrors: deliveryErrors.slice(0, 3),
        },
        "Push notification delivery returned Expo ticket errors",
      );
    }

    // All tokens were invalid: nothing was delivered, but retrying with the
    // same tokens won't help, so do not fail the channel. Emit a high-signal
    // log so this is observable and alertable.
    if (result.sent === 0 && result.failed === 0 && result.invalidTokens.length > 0) {
      this.logger.warn(
        {
          bookingId,
          type,
          invalidTokenCount: result.invalidTokens.length,
        },
        "Push notification skipped: all push tokens for booking are invalid",
      );
    }

    const invalidTokenSet = new Set(result.invalidTokens);
    const tokenErrorMap = new Map(
      deliveryErrors
        .filter((error): error is typeof error & { token: string } => Boolean(error.token))
        .map((error) => [error.token, error]),
    );
    const perRecipientResults: NotificationRecipientResult[] = uniquePushRecipients.map(
      ({ recipient, pushToken }) => {
        const tokenError = tokenErrorMap.get(pushToken);
        const isInvalidToken = invalidTokenSet.has(pushToken);
        const success = !tokenError && !isInvalidToken;

        if (success) {
          return {
            recipient,
            channel: NotificationChannel.PUSH,
            pushToken,
            success: true,
            messageId: "push-sent",
          };
        }

        if (tokenError) {
          return {
            recipient,
            channel: NotificationChannel.PUSH,
            pushToken,
            success: false,
            error: tokenError.message ?? tokenError.code,
            pushResponse: {
              code: tokenError.code,
              retryable: tokenError.retryable,
              message: tokenError.message,
            },
          };
        }

        return {
          recipient,
          channel: NotificationChannel.PUSH,
          pushToken,
          success: false,
          error: "Device not registered",
          pushResponse: {
            code: "DeviceNotRegistered",
            retryable: false,
            message: "Device not registered",
          },
        };
      },
    );

    const actionableErrors = deliveryErrors.filter((error) => error.code !== "DeviceNotRegistered");
    const hasActionableErrors = actionableErrors.length > 0;
    const retryable = hasActionableErrors
      ? actionableErrors.some((error) => error.retryable)
      : undefined;
    const actionableErrorCodes = [...new Set(actionableErrors.map((error) => error.code))];

    return {
      channel: NotificationChannel.PUSH,
      success: !hasActionableErrors,
      retryable,
      messageId: result.sent > 0 ? "push-sent" : undefined,
      error: hasActionableErrors
        ? `One or more push notifications failed (${actionableErrorCodes.join(", ") || "unknown"})`
        : undefined,
      perRecipientResults,
    };
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
    this.logger.info(
      { type: job.data.type, jobId: job.id, durationMs: duration },
      "Notification job completed",
    );
  }

  @OnWorkerEvent("failed")
  onFailed(job: Job<NotificationJobData, NotificationResult[]>, error: Error) {
    const failedChannels =
      error instanceof NotificationDispatchError ? error.failedChannels : undefined;
    const attempt = error instanceof NotificationDispatchError ? error.attempt : job.attemptsMade;
    const maxAttempts =
      error instanceof NotificationDispatchError ? error.maxAttempts : job.opts.attempts;

    this.logger.error(
      {
        type: job.data.type,
        jobId: job.id,
        notificationId: job.data.id,
        bookingId: job.data.bookingId,
        channels: job.data.channels,
        failedChannels,
        error: error.message,
        stack: error.stack,
        attempts: attempt,
        maxAttempts,
      },
      "Notification job failed",
    );
  }

  @OnWorkerEvent("active")
  onActive(job: Job<NotificationJobData, NotificationResult[]>) {
    this.logger.info(
      {
        type: job.data.type,
        jobId: job.id,
        attempt: job.attemptsMade + 1,
        notificationId: job.data.id,
        channels: job.data.channels,
      },
      "Notification job started",
    );
  }

  @OnWorkerEvent("stalled")
  onStalled(jobId: string) {
    this.logger.warn({ jobId }, "Notification job stalled");
  }

  @OnWorkerEvent("progress")
  onProgress(job: Job<NotificationJobData, NotificationResult[]>, progress: number | object) {
    this.logger.debug(
      { type: job.data.type, jobId: job.id, progress },
      "Notification job progress",
    );
  }
}
