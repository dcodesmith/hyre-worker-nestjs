import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import { metrics } from "@opentelemetry/api";
import { Job, JobsOptions, Queue } from "bullmq";
import { PinoLogger } from "nestjs-pino";
import { NOTIFICATIONS_QUEUE } from "src/config/constants";
import { normaliseBookingDetails } from "../../shared/helper";
import { BookingWithRelations, NormalisedBookingLegDetails } from "../../types";
import {
  CHAUFFEUR_RECIPIENT_TYPE,
  CLIENT_RECIPIENT_TYPE,
  FLEET_OWNER_RECIPIENT_TYPE,
  HIGH_PRIORITY_JOB_OPTIONS,
  SEND_NOTIFICATION_JOB_NAME,
} from "./notification.const";
import {
  NotificationChannel,
  NotificationJobData,
  NotificationResult,
  NotificationType,
  QueueReviewReceivedNotificationParams,
} from "./notification.interface";
import { deriveNotificationChannels } from "./notification-channel.helper";
import { RecipientChannelResolverService } from "./recipient-channel-resolver.service";
import {
  BOOKING_CANCELLED_TEMPLATE_KIND,
  BOOKING_REMINDER_TEMPLATE_KIND,
  BOOKING_STATUS_TEMPLATE_KIND,
  REVIEW_RECEIVED_TEMPLATE_KIND,
  RecipientType,
} from "./template-data.interface";

/**
 * Context required to resolve push delivery for booking reminders.
 *
 * `NormalisedBookingLegDetails` is template-only, so callers must explicitly
 * pass the operational user IDs (and optionally pre-resolved push tokens).
 * Making this required prevents accidental push omission on the reminder path.
 */
export type ReminderRecipientContext = {
  customerUserId?: string;
  chauffeurUserId?: string;
  customerPushTokens?: string[];
  chauffeurPushTokens?: string[];
};

@Injectable()
export class NotificationService {
  private readonly notificationSkippedNoChannelCounter = metrics
    .getMeter("notification-service")
    .createCounter("notification_skipped_no_channel");

  constructor(
    @InjectQueue(NOTIFICATIONS_QUEUE)
    private readonly notificationQueue: Queue<NotificationJobData>,
    private readonly recipientChannelResolver: RecipientChannelResolverService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(NotificationService.name);
  }

  /**
   * Queue a notification for a change in a booking's status.
   */
  async queueBookingStatusNotifications(
    booking: BookingWithRelations,
    oldStatus: string,
    newStatus: string,
    showReviewRequest = false,
  ): Promise<void> {
    const jobData = await this.buildBookingStatusChangeJobData({
      booking,
      oldStatus,
      newStatus,
      showReviewRequest,
    });
    if (!jobData) {
      this.logger.warn(
        { bookingId: booking.id, oldStatus, newStatus },
        "No customer delivery channel available for booking status notification",
      );
      this.recordNotificationSkippedNoChannel({
        bookingId: booking.id,
        oldStatus,
        newStatus,
      });
      return;
    }

    await this.addJobToQueue(jobData, HIGH_PRIORITY_JOB_OPTIONS);

    this.logStatusChangeNotification(booking.id, oldStatus, newStatus, jobData.channels);
  }

  async buildBookingStatusChangeJobData({
    booking,
    oldStatus,
    newStatus,
    showReviewRequest = false,
  }: {
    booking: BookingWithRelations;
    oldStatus: string;
    newStatus: string;
    showReviewRequest?: boolean;
  }): Promise<NotificationJobData | null> {
    const bookingDetails = normaliseBookingDetails(booking);
    const customerChannels = await this.recipientChannelResolver.resolve({
      email: bookingDetails.customerEmail,
      phoneNumber: bookingDetails.customerPhone,
      userId: booking.userId ?? booking.user?.id ?? undefined,
    });

    if (customerChannels.channels.length === 0) {
      return null;
    }

    return {
      id: `status-${bookingDetails.id}-${Date.now()}`,
      type: NotificationType.BOOKING_STATUS_CHANGE,
      channels: customerChannels.channels,
      bookingId: bookingDetails.id,
      recipients: {
        [CLIENT_RECIPIENT_TYPE]: {
          email: bookingDetails.customerEmail,
          phoneNumber: bookingDetails.customerPhone,
          pushTokens: customerChannels.pushTokens,
        },
      },
      pushPayload: {
        title: this.getStatusChangeSubject(newStatus),
        body: `Your booking is now ${newStatus.toLowerCase()}.`,
        data: {
          bookingId: bookingDetails.id,
          type: NotificationType.BOOKING_STATUS_CHANGE,
        },
      },
      templateData: {
        templateKind: BOOKING_STATUS_TEMPLATE_KIND,
        ...bookingDetails,
        oldStatus,
        newStatus,
        subject: this.getStatusChangeSubject(newStatus),
        showReviewRequest,
      },
    };
  }

  /**
   * Queue a notification when a chauffeur is assigned to a booking.
   */
  async queueChauffeurAssignedNotifications(booking: BookingWithRelations): Promise<void> {
    const jobData = await this.buildChauffeurAssignedJobData(booking);
    if (!jobData) {
      this.logger.warn(
        { bookingId: booking.id },
        "No customer delivery channel available for chauffeur assignment",
      );
      this.recordNotificationSkippedNoChannel({
        bookingId: booking.id,
        oldStatus: booking.status,
        newStatus: "CHAUFFEUR_ASSIGNED",
      });
      return;
    }

    await this.addJobToQueue(jobData, HIGH_PRIORITY_JOB_OPTIONS);
    this.logger.info(
      { bookingId: booking.id, channels: jobData.channels },
      "Queued chauffeur assignment notification",
    );
  }

  async enqueuePreparedNotification(
    jobData: NotificationJobData,
    options?: JobsOptions,
  ): Promise<Job<NotificationJobData, NotificationResult[] | null, string>> {
    return this.addJobToQueue(jobData, options);
  }

  async buildChauffeurAssignedJobData(
    booking: BookingWithRelations,
    input?: { pushTokens?: string[] },
  ): Promise<NotificationJobData | null> {
    const bookingDetails = normaliseBookingDetails(booking);
    const customerChannels = await this.recipientChannelResolver.resolve({
      email: bookingDetails.customerEmail,
      phoneNumber: bookingDetails.customerPhone,
      userId: booking.userId ?? booking.user?.id ?? undefined,
      pushTokens: input?.pushTokens,
    });

    if (customerChannels.channels.length === 0) {
      return null;
    }

    return {
      id: `chauffeur-assigned-${bookingDetails.id}-${Date.now()}`,
      type: NotificationType.CHAUFFEUR_ASSIGNED,
      channels: customerChannels.channels,
      bookingId: bookingDetails.id,
      recipients: {
        [CLIENT_RECIPIENT_TYPE]: {
          email: bookingDetails.customerEmail,
          phoneNumber: bookingDetails.customerPhone,
          pushTokens: customerChannels.pushTokens,
        },
      },
      pushPayload: {
        title: "Your chauffeur has been assigned",
        body: `Your chauffeur for ${bookingDetails.carName} has been assigned.`,
        data: {
          bookingId: bookingDetails.id,
          type: NotificationType.CHAUFFEUR_ASSIGNED,
        },
      },
      templateData: {
        templateKind: BOOKING_STATUS_TEMPLATE_KIND,
        ...bookingDetails,
        title: "been assigned a chauffeur",
        status: "chauffeur assigned",
        oldStatus: booking.status.toLowerCase(),
        newStatus: "chauffeur_assigned",
        subject: "Your chauffeur has been assigned",
      },
    };
  }

  /**
   * Queue cancellation notifications for both the customer and the fleet owner.
   */
  async queueBookingCancellationNotifications(booking: BookingWithRelations): Promise<void> {
    const bookingDetails = normaliseBookingDetails(booking);

    const templateData = {
      templateKind: BOOKING_CANCELLED_TEMPLATE_KIND,
      ...bookingDetails,
      subject: "Your booking has been cancelled",
    } as const;

    const customerJobData: NotificationJobData = {
      id: `cancelled-client-${bookingDetails.id}-${Date.now()}`,
      type: NotificationType.BOOKING_CANCELLED,
      channels: deriveNotificationChannels(bookingDetails),
      bookingId: bookingDetails.id,
      recipients: {
        [CLIENT_RECIPIENT_TYPE]: {
          email: bookingDetails.customerEmail,
          phoneNumber: bookingDetails.customerPhone,
        },
      },
      templateData,
    };

    const jobs: Promise<unknown>[] = [];
    if (customerJobData.channels.length > 0) {
      jobs.push(this.addJobToQueue(customerJobData, HIGH_PRIORITY_JOB_OPTIONS));
    } else {
      this.logger.warn(
        { bookingId: bookingDetails.id },
        "No customer delivery channel available for booking cancellation",
      );
    }

    const ownerEmail = booking.car?.owner?.email;
    const ownerPhone = booking.car?.owner?.phoneNumber;

    if (ownerEmail || ownerPhone) {
      const ownerJobData: NotificationJobData = {
        id: `cancelled-owner-${bookingDetails.id}-${Date.now()}`,
        type: NotificationType.BOOKING_CANCELLED,
        channels: deriveNotificationChannels({
          email: ownerEmail ?? undefined,
          phoneNumber: ownerPhone ?? undefined,
        }),
        bookingId: bookingDetails.id,
        recipients: {
          [FLEET_OWNER_RECIPIENT_TYPE]: {
            email: ownerEmail ?? undefined,
            phoneNumber: ownerPhone ?? undefined,
          },
        },
        templateData: {
          ...templateData,
          subject: "A booking for your vehicle has been cancelled",
        },
      };
      jobs.push(this.addJobToQueue(ownerJobData, HIGH_PRIORITY_JOB_OPTIONS));
    }

    if (jobs.length === 0) {
      this.logger.warn(
        { bookingId: bookingDetails.id },
        "No delivery channels available for booking cancellation notifications",
      );
      this.recordNotificationSkippedNoChannel({
        bookingId: bookingDetails.id,
        oldStatus: booking.status,
        newStatus: "CANCELLED",
      });
      return;
    }

    await Promise.all(jobs);

    this.logger.info(
      { bookingId: bookingDetails.id, notifiedOwner: !!(ownerEmail || ownerPhone) },
      "Queued booking cancellation notifications",
    );
  }

  /**
   * Queue reminder notifications for a specific booking leg (for both customer and chauffeur).
   */
  async queueBookingReminderNotifications(
    bookingLegDetails: NormalisedBookingLegDetails,
    type: NotificationType.BOOKING_REMINDER_START | NotificationType.BOOKING_REMINDER_END,
    context: ReminderRecipientContext,
  ): Promise<void> {
    const reminderJobs = await this.buildBookingReminderJobData(bookingLegDetails, type, context);
    await Promise.all(reminderJobs.map((jobData) => this.addJobToQueue(jobData)));

    this.logReminderNotifications(bookingLegDetails, type);
  }

  async buildBookingReminderJobData(
    bookingLegDetails: NormalisedBookingLegDetails,
    type: NotificationType.BOOKING_REMINDER_START | NotificationType.BOOKING_REMINDER_END,
    context: ReminderRecipientContext,
  ): Promise<NotificationJobData[]> {
    const jobs: NotificationJobData[] = [];
    const customerReminder = await this.createReminderJobData({
      bookingLegDetails,
      recipientType: CLIENT_RECIPIENT_TYPE,
      email: bookingLegDetails.customerEmail,
      phoneNumber: bookingLegDetails.customerPhone,
      userId: context.customerUserId,
      pushTokens: context.customerPushTokens,
      type,
    });
    if (customerReminder) {
      jobs.push(customerReminder);
    }

    const chauffeurReminder = await this.createReminderJobData({
      bookingLegDetails,
      recipientType: CHAUFFEUR_RECIPIENT_TYPE,
      email: bookingLegDetails.chauffeurEmail,
      phoneNumber: bookingLegDetails.chauffeurPhone,
      userId: context.chauffeurUserId,
      pushTokens: context.chauffeurPushTokens,
      type,
    });
    if (chauffeurReminder) {
      jobs.push(chauffeurReminder);
    }

    return jobs;
  }

  /**
   * Queue review received notifications for both fleet owner and chauffeur.
   * Email-only for now (no WhatsApp template configured for review notifications).
   */
  async queueReviewReceivedNotifications(
    params: QueueReviewReceivedNotificationParams,
  ): Promise<void> {
    const ownerJobData: NotificationJobData = {
      id: `review-received-owner-${params.bookingId}-${Date.now()}`,
      type: NotificationType.REVIEW_RECEIVED,
      channels: [NotificationChannel.EMAIL],
      bookingId: params.bookingId,
      recipients: {
        [FLEET_OWNER_RECIPIENT_TYPE]: {
          email: params.owner.email,
        },
      },
      templateData: {
        templateKind: REVIEW_RECEIVED_TEMPLATE_KIND,
        ownerName: params.owner.name,
        chauffeurName: params.chauffeur.name,
        ...params.review,
        subject: `New ${params.review.overallRating}-star review received for ${params.review.carName}`,
      },
    };

    const chauffeurJobData: NotificationJobData = {
      id: `review-received-chauffeur-${params.bookingId}-${Date.now()}`,
      type: NotificationType.REVIEW_RECEIVED,
      channels: [NotificationChannel.EMAIL],
      bookingId: params.bookingId,
      recipients: {
        [CHAUFFEUR_RECIPIENT_TYPE]: {
          email: params.chauffeur.email,
        },
      },
      templateData: {
        templateKind: REVIEW_RECEIVED_TEMPLATE_KIND,
        ownerName: params.owner.name,
        chauffeurName: params.chauffeur.name,
        ...params.review,
        subject: `New ${params.review.chauffeurRating}-star review received for your service`,
      },
    };

    await Promise.all([this.addJobToQueue(ownerJobData), this.addJobToQueue(chauffeurJobData)]);

    this.logger.info(
      { bookingId: params.bookingId, channels: [NotificationChannel.EMAIL] },
      "Queued review received notifications",
    );
  }

  private async createReminderJobData({
    bookingLegDetails,
    recipientType,
    email,
    phoneNumber,
    userId,
    pushTokens,
    type,
  }: {
    bookingLegDetails: NormalisedBookingLegDetails;
    recipientType: RecipientType;
    email: string | undefined;
    phoneNumber: string | undefined;
    userId: string | undefined;
    pushTokens?: string[];
    type: NotificationType.BOOKING_REMINDER_START | NotificationType.BOOKING_REMINDER_END;
  }): Promise<NotificationJobData | null> {
    const recipientChannels = await this.recipientChannelResolver.resolve({
      email,
      phoneNumber,
      userId,
      pushTokens,
    });
    if (recipientChannels.channels.length === 0) {
      return null;
    }

    const subject =
      recipientType === CLIENT_RECIPIENT_TYPE
        ? this.getReminderSubject(type)
        : this.getChauffeurReminderSubject(type);

    return {
      id: `reminder-${recipientType}-${bookingLegDetails.bookingLegId}-${type}-${Date.now()}`,
      type,
      channels: recipientChannels.channels,
      bookingId: bookingLegDetails.bookingId,
      recipients: {
        [recipientType]: {
          email,
          phoneNumber,
          pushTokens: recipientChannels.pushTokens,
        },
      },
      pushPayload: {
        title:
          type === NotificationType.BOOKING_REMINDER_START
            ? "Your booking starts in 1 hour"
            : "Your booking ends in 1 hour",
        body:
          recipientType === CLIENT_RECIPIENT_TYPE
            ? this.getReminderSubject(type)
            : this.getChauffeurReminderSubject(type),
        data: {
          bookingId: bookingLegDetails.bookingId,
          type,
        },
      },
      templateData: {
        templateKind: BOOKING_REMINDER_TEMPLATE_KIND,
        ...bookingLegDetails,
        recipientType,
        subject,
      },
    };
  }

  private addJobToQueue(
    jobData: NotificationJobData,
    options?: JobsOptions,
  ): Promise<Job<NotificationJobData, NotificationResult[] | null, string>> {
    return this.notificationQueue.add(SEND_NOTIFICATION_JOB_NAME, jobData, options);
  }

  private logStatusChangeNotification(
    bookingId: string,
    oldStatus: string,
    newStatus: string,
    channels: NotificationChannel[],
  ): void {
    this.logger.info(
      { bookingId, oldStatus, newStatus, channels },
      "Queued booking status notification",
    );
  }

  private logReminderNotifications(
    bookingLegDetails: NormalisedBookingLegDetails,
    type: NotificationType.BOOKING_REMINDER_START | NotificationType.BOOKING_REMINDER_END,
  ): void {
    const { chauffeurEmail, chauffeurPhone, customerEmail, customerPhone } = bookingLegDetails;

    this.logger.info(
      {
        bookingLegId: bookingLegDetails.bookingLegId,
        type,
        customerChannels: deriveNotificationChannels({
          email: customerEmail,
          phoneNumber: customerPhone,
        }),
        chauffeurChannels: deriveNotificationChannels({
          email: chauffeurEmail,
          phoneNumber: chauffeurPhone,
        }),
      },
      "Queued booking reminder notifications",
    );
  }

  private getStatusChangeSubject(status: string): string {
    switch (status.toLowerCase()) {
      case "active":
        return "Your booking has started";
      case "completed":
        return "Your booking has ended";
      case "cancelled":
        return "Your booking has been cancelled";
      default:
        return "Your booking status has been updated";
    }
  }

  private getReminderSubject(
    type: NotificationType.BOOKING_REMINDER_START | NotificationType.BOOKING_REMINDER_END,
  ): string {
    return type === NotificationType.BOOKING_REMINDER_START
      ? "Booking Reminder - Your service starts in approximately 1 hour"
      : "Booking Reminder - Your service ends in approximately 1 hour";
  }

  private getChauffeurReminderSubject(
    type: NotificationType.BOOKING_REMINDER_START | NotificationType.BOOKING_REMINDER_END,
  ): string {
    return type === NotificationType.BOOKING_REMINDER_START
      ? "Booking Reminder - You have a service starting in approximately 1 hour"
      : "Booking Reminder - Your assigned booking for today ends in approximately 1 hour";
  }

  private recordNotificationSkippedNoChannel(input: {
    bookingId: string;
    oldStatus: string;
    newStatus: string;
  }): void {
    this.logger.debug(
      {
        bookingId: input.bookingId,
        oldStatus: input.oldStatus,
        newStatus: input.newStatus,
        reason: "no_channel",
      },
      "Incrementing notification_skipped_no_channel counter",
    );

    this.notificationSkippedNoChannelCounter.add(1, {
      oldStatus: input.oldStatus,
      newStatus: input.newStatus,
      reason: "no_channel",
    });
  }
}
