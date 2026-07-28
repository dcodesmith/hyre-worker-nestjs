import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import { Job, JobsOptions, Queue } from "bullmq";
import { PinoLogger } from "nestjs-pino";
import { NOTIFICATIONS_QUEUE } from "src/config/constants";
import { normaliseBookingDetails } from "../../shared/helper";
import { BookingWithRelations, NormalisedBookingLegDetails } from "../../types";
import {
  CHAUFFEUR_RECIPIENT_TYPE,
  CLIENT_RECIPIENT_TYPE,
  FLEET_OWNER_RECIPIENT_TYPE,
  SEND_NOTIFICATION_JOB_NAME,
} from "./notification.const";
import {
  NotificationAudience,
  NotificationChannel,
  NotificationJobData,
  NotificationResult,
  NotificationType,
  QueueReviewReceivedNotificationParams,
} from "./notification.interface";
import { RecipientChannelResolverService } from "./recipient-channel-resolver.service";
import {
  BOOKING_CANCELLED_TEMPLATE_KIND,
  BOOKING_CONFIRMED_TEMPLATE_KIND,
  BOOKING_REMINDER_TEMPLATE_KIND,
  BOOKING_STATUS_TEMPLATE_KIND,
  FLEET_OWNER_NEW_BOOKING_TEMPLATE_KIND,
  REVIEW_RECEIVED_TEMPLATE_KIND,
  RecipientType,
} from "./template-data.interface";

/**
 * Context required to resolve push delivery for booking reminders.
 *
 * `NormalisedBookingLegDetails` is template-only, so callers must explicitly
 * pass the operational user IDs.
 * Making this required prevents accidental push omission on the reminder path.
 */
export type ReminderRecipientContext = {
  customerUserId?: string;
  chauffeurUserId?: string;
};

@Injectable()
export class NotificationService {
  constructor(
    @InjectQueue(NOTIFICATIONS_QUEUE)
    private readonly notificationQueue: Queue<NotificationJobData>,
    private readonly recipientChannelResolver: RecipientChannelResolverService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(NotificationService.name);
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
    const customerChannels = this.recipientChannelResolver.resolve({
      audience: NotificationAudience.CUSTOMER,
      email: bookingDetails.customerEmail,
      phoneNumber: bookingDetails.customerPhone,
      userId: booking.userId ?? booking.user?.id ?? undefined,
    });

    if (customerChannels.length === 0) {
      return null;
    }

    return {
      id: `status-${bookingDetails.id}-${Date.now()}`,
      type: NotificationType.BOOKING_STATUS_CHANGE,
      audience: NotificationAudience.CUSTOMER,
      channels: customerChannels,
      bookingId: bookingDetails.id,
      recipients: {
        [CLIENT_RECIPIENT_TYPE]: {
          userId: booking.userId ?? booking.user?.id ?? undefined,
          email: bookingDetails.customerEmail,
          phoneNumber: bookingDetails.customerPhone,
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

  async enqueuePreparedNotification(
    jobData: NotificationJobData,
    options?: JobsOptions,
  ): Promise<Job<NotificationJobData, NotificationResult[] | null, string>> {
    return this.addJobToQueue(jobData, options);
  }

  async buildChauffeurAssignedJobData(
    booking: BookingWithRelations,
  ): Promise<NotificationJobData | null> {
    const bookingDetails = normaliseBookingDetails(booking);
    const customerChannels = this.recipientChannelResolver.resolve({
      audience: NotificationAudience.CUSTOMER,
      email: bookingDetails.customerEmail,
      phoneNumber: bookingDetails.customerPhone,
      userId: booking.userId ?? booking.user?.id ?? undefined,
    });

    if (customerChannels.length === 0) {
      return null;
    }

    return {
      id: `chauffeur-assigned-${bookingDetails.id}-${Date.now()}`,
      type: NotificationType.CHAUFFEUR_ASSIGNED,
      audience: NotificationAudience.CUSTOMER,
      channels: customerChannels,
      bookingId: bookingDetails.id,
      recipients: {
        [CLIENT_RECIPIENT_TYPE]: {
          userId: booking.userId ?? booking.user?.id ?? undefined,
          email: bookingDetails.customerEmail,
          phoneNumber: bookingDetails.customerPhone,
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

  async buildBookingConfirmedJobData(booking: BookingWithRelations): Promise<{
    customer: NotificationJobData | null;
    owner: NotificationJobData | null;
  }> {
    const bookingDetails = normaliseBookingDetails(booking);
    const customerUserId = booking.userId ?? booking.user?.id ?? undefined;
    const ownerUserId = booking.car?.owner?.id ?? undefined;
    const ownerEmail = booking.car?.owner?.email ?? undefined;
    const ownerPhone = booking.car?.owner?.phoneNumber ?? undefined;

    const customerChannels = this.recipientChannelResolver.resolve({
      audience: NotificationAudience.CUSTOMER,
      email: bookingDetails.customerEmail,
      phoneNumber: bookingDetails.customerPhone,
      userId: customerUserId,
    });
    const ownerChannels = this.recipientChannelResolver.resolve({
      audience: NotificationAudience.FLEET_OWNER,
      email: ownerEmail,
      phoneNumber: ownerPhone,
      userId: ownerUserId,
    });

    const customer: NotificationJobData | null =
      customerChannels.length > 0
        ? {
            id: `booking-confirmed-${booking.id}-${Date.now()}`,
            type: NotificationType.BOOKING_CONFIRMED,
            audience: NotificationAudience.CUSTOMER,
            channels: customerChannels,
            bookingId: booking.id,
            recipients: {
              [CLIENT_RECIPIENT_TYPE]: {
                userId: customerUserId,
                email: bookingDetails.customerEmail,
                phoneNumber: bookingDetails.customerPhone,
              },
            },
            templateData: {
              templateKind: BOOKING_CONFIRMED_TEMPLATE_KIND,
              ...bookingDetails,
              subject: "Your booking is confirmed!",
            },
          }
        : null;

    const owner: NotificationJobData | null =
      ownerChannels.length > 0
        ? {
            id: `fleet-owner-new-booking-${booking.id}-${Date.now()}`,
            type: NotificationType.FLEET_OWNER_NEW_BOOKING,
            audience: NotificationAudience.FLEET_OWNER,
            channels: ownerChannels,
            bookingId: booking.id,
            recipients: {
              [FLEET_OWNER_RECIPIENT_TYPE]: {
                userId: ownerUserId,
                email: ownerEmail,
                phoneNumber: ownerPhone,
              },
            },
            templateData: {
              templateKind: FLEET_OWNER_NEW_BOOKING_TEMPLATE_KIND,
              ...bookingDetails,
              subject: "New Booking Alert",
            },
          }
        : null;

    return { customer, owner };
  }

  /**
   * Build the cancellation NotificationJobData payloads for the customer and
   * (optionally) the fleet owner. Returns one entry per recipient with delivery
   * channels available; recipients without channels are omitted.
   *
   * Used by the BookingCancellationHandler — direct dispatch via the queue is
   * intentionally not exposed because cancellation must always go through the
   * outbox to stay durable across worker crashes (architectural review,
   * Issue 4A).
   *
   * Channel resolution mirrors the other builders (status / chauffeur-assigned
   * / reminder) — both customer and fleet-owner paths go through
   * `recipientChannelResolver.resolve`, which schedules PUSH for supported
   * customer audiences with a user ID. Active tokens are resolved only when
   * the worker delivers the job, so durable payloads do not contain snapshots.
   */
  async buildBookingCancellationJobData(booking: BookingWithRelations): Promise<{
    customer: NotificationJobData | null;
    owner: NotificationJobData | null;
  }> {
    const bookingDetails = normaliseBookingDetails(booking);
    const baseTemplateData = {
      templateKind: BOOKING_CANCELLED_TEMPLATE_KIND,
      ...bookingDetails,
      subject: "Your booking has been cancelled",
    } as const;

    const ownerEmail = booking.car?.owner?.email ?? undefined;
    const ownerPhone = booking.car?.owner?.phoneNumber ?? undefined;

    const customerChannels = this.recipientChannelResolver.resolve({
      audience: NotificationAudience.CUSTOMER,
      email: bookingDetails.customerEmail,
      phoneNumber: bookingDetails.customerPhone,
      userId: booking.userId ?? booking.user?.id ?? undefined,
    });
    const ownerChannels = this.recipientChannelResolver.resolve({
      audience: NotificationAudience.FLEET_OWNER,
      email: ownerEmail,
      phoneNumber: ownerPhone,
      userId: booking.car?.owner?.id ?? undefined,
    });

    const customer: NotificationJobData | null =
      customerChannels.length > 0
        ? {
            id: `cancelled-client-${bookingDetails.id}-${Date.now()}`,
            type: NotificationType.BOOKING_CANCELLED,
            audience: NotificationAudience.CUSTOMER,
            channels: customerChannels,
            bookingId: bookingDetails.id,
            recipients: {
              [CLIENT_RECIPIENT_TYPE]: {
                userId: booking.userId ?? booking.user?.id ?? undefined,
                email: bookingDetails.customerEmail,
                phoneNumber: bookingDetails.customerPhone,
              },
            },
            pushPayload: {
              title: "Your booking has been cancelled",
              body: "Your booking has been cancelled. A refund is being processed.",
              data: {
                bookingId: bookingDetails.id,
                type: NotificationType.BOOKING_CANCELLED,
              },
            },
            templateData: baseTemplateData,
          }
        : null;

    const owner: NotificationJobData | null =
      ownerChannels.length > 0
        ? {
            id: `cancelled-owner-${bookingDetails.id}-${Date.now()}`,
            type: NotificationType.BOOKING_CANCELLED,
            audience: NotificationAudience.FLEET_OWNER,
            channels: ownerChannels,
            bookingId: bookingDetails.id,
            recipients: {
              [FLEET_OWNER_RECIPIENT_TYPE]: {
                userId: booking.car?.owner?.id ?? undefined,
                email: ownerEmail,
                phoneNumber: ownerPhone,
              },
            },
            pushPayload: {
              title: "A booking for your vehicle has been cancelled",
              body: `A booking for ${bookingDetails.carName} has been cancelled.`,
              data: {
                bookingId: bookingDetails.id,
                type: NotificationType.BOOKING_CANCELLED,
              },
            },
            templateData: {
              ...baseTemplateData,
              subject: "A booking for your vehicle has been cancelled",
            },
          }
        : null;

    if (!customer && !owner) {
      this.logger.warn(
        { bookingId: bookingDetails.id },
        "No delivery channels available for booking cancellation notifications",
      );
    }

    return { customer, owner };
  }

  async buildBookingReminderJobData(
    bookingLegDetails: NormalisedBookingLegDetails,
    type: NotificationType.BOOKING_REMINDER_START | NotificationType.BOOKING_REMINDER_END,
    context: ReminderRecipientContext,
  ): Promise<NotificationJobData[]> {
    const jobs: NotificationJobData[] = [];

    const [customerReminder, chauffeurReminder] = await Promise.all([
      this.createReminderJobData({
        bookingLegDetails,
        recipientType: CLIENT_RECIPIENT_TYPE,
        email: bookingLegDetails.customerEmail,
        phoneNumber: bookingLegDetails.customerPhone,
        userId: context.customerUserId,
        type,
      }),
      this.createReminderJobData({
        bookingLegDetails,
        recipientType: CHAUFFEUR_RECIPIENT_TYPE,
        email: bookingLegDetails.chauffeurEmail,
        phoneNumber: bookingLegDetails.chauffeurPhone,
        userId: context.chauffeurUserId,
        type,
      }),
    ]);

    if (customerReminder) {
      jobs.push(customerReminder);
    }
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
      audience: NotificationAudience.FLEET_OWNER,
      channels: [NotificationChannel.EMAIL],
      bookingId: params.bookingId,
      recipients: {
        [FLEET_OWNER_RECIPIENT_TYPE]: {
          userId: params.owner.userId,
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
      audience: NotificationAudience.CHAUFFEUR,
      channels: [NotificationChannel.EMAIL],
      bookingId: params.bookingId,
      recipients: {
        [CHAUFFEUR_RECIPIENT_TYPE]: {
          userId: params.chauffeur.userId,
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
    type,
  }: {
    bookingLegDetails: NormalisedBookingLegDetails;
    recipientType: RecipientType;
    email: string | undefined;
    phoneNumber: string | undefined;
    userId: string | undefined;
    type: NotificationType.BOOKING_REMINDER_START | NotificationType.BOOKING_REMINDER_END;
  }): Promise<NotificationJobData | null> {
    const audience =
      recipientType === CLIENT_RECIPIENT_TYPE
        ? NotificationAudience.CUSTOMER
        : NotificationAudience.CHAUFFEUR;
    const recipientChannels = this.recipientChannelResolver.resolve({
      audience,
      email,
      phoneNumber,
      userId,
    });
    if (recipientChannels.length === 0) {
      return null;
    }

    const subject =
      recipientType === CLIENT_RECIPIENT_TYPE
        ? this.getReminderSubject(type)
        : this.getChauffeurReminderSubject(type);

    return {
      id: `reminder-${recipientType}-${bookingLegDetails.bookingLegId}-${type}-${Date.now()}`,
      type,
      audience,
      channels: recipientChannels,
      bookingId: bookingLegDetails.bookingId,
      recipients: {
        [recipientType]: {
          userId,
          email,
          phoneNumber,
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
