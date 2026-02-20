import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import { Job, JobsOptions, Queue } from "bullmq";
import { NOTIFICATIONS_QUEUE } from "src/config/constants";
import { normaliseBookingDetails, normaliseBookingLegDetails } from "../../shared/helper";
import {
  BookingWithRelations,
  NormalisedBookingDetails,
  NormalisedBookingLegDetails,
} from "../../types";
import {
  CHAUFFEUR_RECIPIENT_TYPE,
  CLIENT_RECIPIENT_TYPE,
  DEFAULT_CHANNELS,
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
import {
  BOOKING_CANCELLED_TEMPLATE_KIND,
  BOOKING_REMINDER_TEMPLATE_KIND,
  BOOKING_STATUS_TEMPLATE_KIND,
  REVIEW_RECEIVED_TEMPLATE_KIND,
  RecipientType,
} from "./template-data.interface";

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @InjectQueue(NOTIFICATIONS_QUEUE)
    private readonly notificationQueue: Queue<NotificationJobData>,
  ) {}

  /**
   * Queue a notification for a change in a booking's status.
   */
  async queueBookingStatusNotifications(
    booking: BookingWithRelations,
    oldStatus: string,
    newStatus: string,
    showReviewRequest = false,
  ): Promise<void> {
    const bookingDetails = normaliseBookingDetails(booking);

    const jobData = this.createStatusChangeJobData({
      bookingDetails,
      oldStatus,
      newStatus,
      showReviewRequest,
    });

    await this.addJobToQueue(jobData, HIGH_PRIORITY_JOB_OPTIONS);

    this.logStatusChangeNotification(booking.id, oldStatus, newStatus, jobData.channels);
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
      channels: DEFAULT_CHANNELS,
      bookingId: bookingDetails.id,
      recipients: {
        [CLIENT_RECIPIENT_TYPE]: {
          email: bookingDetails.customerEmail,
          phoneNumber: bookingDetails.customerPhone,
        },
      },
      templateData,
    };

    const ownerEmail = booking.car?.owner?.email;
    const ownerPhone = booking.car?.owner?.phoneNumber;

    const jobs: Promise<unknown>[] = [
      this.addJobToQueue(customerJobData, HIGH_PRIORITY_JOB_OPTIONS),
    ];

    if (ownerEmail || ownerPhone) {
      const ownerJobData: NotificationJobData = {
        id: `cancelled-owner-${bookingDetails.id}-${Date.now()}`,
        type: NotificationType.BOOKING_CANCELLED,
        channels: this.determineChannels(ownerEmail ?? undefined, ownerPhone ?? undefined),
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

    await Promise.all(jobs);

    this.logger.log("Queued booking cancellation notifications", {
      bookingId: bookingDetails.id,
      notifiedOwner: !!(ownerEmail || ownerPhone),
    });
  }

  /**
   * Queue reminder notifications for a specific booking leg (for both customer and chauffeur).
   */
  async queueBookingReminderNotifications(
    bookingLegDetails: NormalisedBookingLegDetails,
    type: NotificationType.BOOKING_REMINDER_START | NotificationType.BOOKING_REMINDER_END,
  ): Promise<void> {
    await this.queueCustomerReminder(bookingLegDetails, type);
    await this.queueChauffeurReminder(bookingLegDetails, type);

    this.logReminderNotifications(bookingLegDetails, type);
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

    this.logger.log("Queued review received notifications", {
      bookingId: params.bookingId,
      channels: [NotificationChannel.EMAIL],
    });
  }

  private createStatusChangeJobData({
    bookingDetails,
    oldStatus,
    newStatus,
    showReviewRequest = false,
  }: {
    bookingDetails: NormalisedBookingDetails;
    oldStatus: string;
    newStatus: string;
    showReviewRequest?: boolean;
  }): NotificationJobData {
    return {
      id: `status-${bookingDetails.id}-${Date.now()}`,
      type: NotificationType.BOOKING_STATUS_CHANGE,
      channels: DEFAULT_CHANNELS,
      bookingId: bookingDetails.id,
      recipients: {
        [CLIENT_RECIPIENT_TYPE]: {
          email: bookingDetails.customerEmail,
          phoneNumber: bookingDetails.customerPhone,
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

  private async queueCustomerReminder(
    bookingLegDetails: ReturnType<typeof normaliseBookingLegDetails>,
    type: NotificationType.BOOKING_REMINDER_START | NotificationType.BOOKING_REMINDER_END,
  ): Promise<void> {
    if (!bookingLegDetails.customerEmail && !bookingLegDetails.customerPhone) return;

    const customerJobData = this.createReminderJobData({
      bookingLegDetails,
      recipientType: CLIENT_RECIPIENT_TYPE,
      email: bookingLegDetails.customerEmail,
      phoneNumber: bookingLegDetails.customerPhone,
      type,
    });

    await this.addJobToQueue(customerJobData);
  }

  private determineChannels(email?: string, phoneNumber?: string): NotificationChannel[] {
    const channels: NotificationChannel[] = [];

    if (email) {
      channels.push(NotificationChannel.EMAIL);
    }

    if (phoneNumber) {
      channels.push(NotificationChannel.WHATSAPP);
    }

    return channels;
  }

  private createReminderJobData({
    bookingLegDetails,
    recipientType,
    email,
    phoneNumber,
    type,
  }: {
    bookingLegDetails: ReturnType<typeof normaliseBookingLegDetails>;
    recipientType: RecipientType;
    email: string | undefined;
    phoneNumber: string | undefined;
    type: NotificationType.BOOKING_REMINDER_START | NotificationType.BOOKING_REMINDER_END;
  }): NotificationJobData {
    const subject =
      recipientType === CLIENT_RECIPIENT_TYPE
        ? this.getReminderSubject(type)
        : this.getChauffeurReminderSubject(type);

    return {
      id: `reminder-${recipientType}-${bookingLegDetails.bookingLegId}-${type}-${Date.now()}`,
      type,
      channels: this.determineChannels(email, phoneNumber),
      bookingId: bookingLegDetails.bookingId,
      recipients: {
        [recipientType]: { email, phoneNumber },
      },
      templateData: {
        templateKind: BOOKING_REMINDER_TEMPLATE_KIND,
        ...bookingLegDetails,
        recipientType,
        subject,
      },
    };
  }

  private async queueChauffeurReminder(
    bookingLegDetails: ReturnType<typeof normaliseBookingLegDetails>,
    type: NotificationType.BOOKING_REMINDER_START | NotificationType.BOOKING_REMINDER_END,
  ): Promise<void> {
    const { chauffeurEmail, chauffeurPhone } = bookingLegDetails;

    if (!chauffeurEmail && !chauffeurPhone) return;

    const chauffeurJobData = this.createReminderJobData({
      bookingLegDetails,
      recipientType: CHAUFFEUR_RECIPIENT_TYPE,
      email: chauffeurEmail,
      phoneNumber: chauffeurPhone,
      type,
    });

    await this.addJobToQueue(chauffeurJobData);
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
    this.logger.log("Queued booking status notification", {
      bookingId,
      oldStatus,
      newStatus,
      channels,
    });
  }

  private logReminderNotifications(
    bookingLegDetails: ReturnType<typeof normaliseBookingLegDetails>,
    type: NotificationType.BOOKING_REMINDER_START | NotificationType.BOOKING_REMINDER_END,
  ): void {
    const { chauffeurEmail, chauffeurPhone, customerEmail, customerPhone } = bookingLegDetails;

    this.logger.log("Queued booking reminder notifications", {
      bookingLegId: bookingLegDetails.bookingLegId,
      type,
      customerChannels: this.determineChannels(customerEmail, customerPhone),
      chauffeurChannels: this.determineChannels(chauffeurEmail, chauffeurPhone),
    });
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
}
