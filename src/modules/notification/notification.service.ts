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
  NotificationChannel,
  NotificationJobData,
  NotificationResult,
  NotificationType,
  QueueReviewReceivedNotificationParams,
} from "./notification.interface";
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
    const customerChannels = await this.recipientChannelResolver.resolve({
      email: bookingDetails.customerEmail,
      phoneNumber: bookingDetails.customerPhone,
      userId: booking.userId ?? booking.user?.id ?? undefined,
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
   * `recipientChannelResolver.resolve`, which also adds the PUSH channel when
   * active push tokens exist. Keeping all builders on the same resolver is the
   * DRY invariant that prevents the "cancellation never produces PUSH" bug.
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

    const [customerChannels, ownerChannels] = await Promise.all([
      this.recipientChannelResolver.resolve({
        email: bookingDetails.customerEmail,
        phoneNumber: bookingDetails.customerPhone,
        userId: booking.userId ?? booking.user?.id ?? undefined,
      }),
      this.recipientChannelResolver.resolve({
        email: ownerEmail,
        phoneNumber: ownerPhone,
        userId: booking.car?.owner?.id ?? undefined,
      }),
    ]);

    const customer: NotificationJobData | null =
      customerChannels.channels.length > 0
        ? {
            id: `cancelled-client-${bookingDetails.id}-${Date.now()}`,
            type: NotificationType.BOOKING_CANCELLED,
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
      ownerChannels.channels.length > 0
        ? {
            id: `cancelled-owner-${bookingDetails.id}-${Date.now()}`,
            type: NotificationType.BOOKING_CANCELLED,
            channels: ownerChannels.channels,
            bookingId: bookingDetails.id,
            recipients: {
              [FLEET_OWNER_RECIPIENT_TYPE]: {
                email: ownerEmail,
                phoneNumber: ownerPhone,
                pushTokens: ownerChannels.pushTokens,
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
        pushTokens: context.customerPushTokens,
        type,
      }),
      this.createReminderJobData({
        bookingLegDetails,
        recipientType: CHAUFFEUR_RECIPIENT_TYPE,
        email: bookingLegDetails.chauffeurEmail,
        phoneNumber: bookingLegDetails.chauffeurPhone,
        userId: context.chauffeurUserId,
        pushTokens: context.chauffeurPushTokens,
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
