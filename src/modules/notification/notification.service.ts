import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { BookingReferralStatus } from "@prisma/client";
import { Job, JobsOptions, Queue } from "bullmq";
import { PinoLogger } from "nestjs-pino";
import { NOTIFICATIONS_QUEUE } from "src/config/constants";
import type { EnvConfig } from "../../config/env.config";
import {
  formatCurrency,
  normaliseBookingDetails,
  normaliseExtensionDetails,
} from "../../shared/helper";
import {
  BookingWithRelations,
  ExtensionWithNotificationRelations,
  NormalisedBookingLegDetails,
} from "../../types";
import {
  CHAUFFEUR_RECIPIENT_TYPE,
  CLIENT_RECIPIENT_TYPE,
  FLEET_OWNER_RECIPIENT_TYPE,
  OPERATIONS_RECIPIENT_TYPE,
  SEND_NOTIFICATION_JOB_NAME,
} from "./notification.const";
import {
  FlightNotificationType,
  NotificationAudience,
  NotificationChannel,
  NotificationJobData,
  NotificationResult,
  NotificationType,
  PayoutStatusChangedNotificationParams,
  ReferralRewardReleasedNotificationParams,
  ReviewReceivedNotificationParams,
} from "./notification.interface";
import {
  createBookingNotificationData,
  createReferralsNotificationData,
} from "./notification-target";
import { RecipientChannelResolverService } from "./recipient-channel-resolver.service";
import {
  BOOKING_CANCELLED_TEMPLATE_KIND,
  BOOKING_CONFIRMED_TEMPLATE_KIND,
  BOOKING_EXTENSION_CONFIRMED_TEMPLATE_KIND,
  BOOKING_REMINDER_TEMPLATE_KIND,
  BOOKING_STATUS_TEMPLATE_KIND,
  FLEET_OWNER_NEW_BOOKING_TEMPLATE_KIND,
  FLIGHT_UPDATE_TEMPLATE_KIND,
  PAYOUT_STATUS_TEMPLATE_KIND,
  PUSH_ONLY_TEMPLATE_KIND,
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
  private readonly flightWhatsAppEnabled: boolean;
  private readonly payoutWhatsAppEnabled: boolean;
  private readonly operationsEmail: string;

  constructor(
    @InjectQueue(NOTIFICATIONS_QUEUE)
    private readonly notificationQueue: Queue<NotificationJobData>,
    private readonly recipientChannelResolver: RecipientChannelResolverService,
    configService: ConfigService<EnvConfig>,
    private readonly logger: PinoLogger,
  ) {
    this.flightWhatsAppEnabled = Boolean(
      configService.get("TWILIO_FLIGHT_OPERATIONAL_UPDATE_CONTENT_SID", { infer: true }),
    );
    this.payoutWhatsAppEnabled = Boolean(
      configService.get("TWILIO_PAYOUT_SUCCEEDED_CONTENT_SID", { infer: true }),
    );
    this.operationsEmail =
      configService.get("OPERATIONS_EMAIL", { infer: true }) ?? "support@tripdly.com";
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
        data: createBookingNotificationData(
          NotificationType.BOOKING_STATUS_CHANGE,
          bookingDetails.id,
        ),
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

  async buildBookingUpdatedJobData(
    booking: BookingWithRelations,
    includePush: boolean,
  ): Promise<NotificationJobData | null> {
    const bookingDetails = normaliseBookingDetails(booking);
    const userId = booking.userId ?? booking.user?.id ?? undefined;
    const channels = this.recipientChannelResolver
      .resolve({
        audience: NotificationAudience.CUSTOMER,
        email: bookingDetails.customerEmail,
        phoneNumber: bookingDetails.customerPhone,
        userId,
      })
      .filter((channel) => includePush || channel !== NotificationChannel.PUSH);

    if (channels.length === 0) {
      return null;
    }

    return {
      id: `booking-updated-${booking.id}-${booking.updatedAt.toISOString()}`,
      type: NotificationType.BOOKING_UPDATED,
      audience: NotificationAudience.CUSTOMER,
      channels,
      bookingId: booking.id,
      recipients: {
        [CLIENT_RECIPIENT_TYPE]: {
          userId,
          email: bookingDetails.customerEmail,
          phoneNumber: bookingDetails.customerPhone,
        },
      },
      pushPayload: {
        title: "Booking updated",
        body: `Your booking for ${bookingDetails.carName} has been updated.`,
        data: createBookingNotificationData(NotificationType.BOOKING_UPDATED, booking.id),
      },
      templateData: {
        templateKind: BOOKING_STATUS_TEMPLATE_KIND,
        ...bookingDetails,
        title: "been updated",
        status: "updated",
        oldStatus: booking.status.toLowerCase(),
        newStatus: booking.status.toLowerCase(),
        subject: "Booking Updated",
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
        data: createBookingNotificationData(NotificationType.CHAUFFEUR_ASSIGNED, bookingDetails.id),
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
    const referralDiscount =
      booking.referralStatus === BookingReferralStatus.APPLIED &&
      booking.referralDiscountAmount.gt(0)
        ? formatCurrency(booking.referralDiscountAmount.toNumber())
        : null;

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
            pushPayload: {
              title: "Booking confirmed",
              body: referralDiscount
                ? `Your booking is confirmed. You saved ${referralDiscount} with your referral discount.`
                : `Your booking for ${bookingDetails.carName} has been confirmed.`,
              data: createBookingNotificationData(NotificationType.BOOKING_CONFIRMED, booking.id),
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

  buildReferralRewardReleasedJobData({
    rewardId,
    bookingId,
    referrerUserId,
    amount,
  }: ReferralRewardReleasedNotificationParams): NotificationJobData {
    const formattedAmount = formatCurrency(amount);

    return {
      id: `referral-reward-released-${rewardId}`,
      type: NotificationType.REFERRAL_REWARD_RELEASED,
      audience: NotificationAudience.CUSTOMER,
      channels: [NotificationChannel.PUSH],
      bookingId,
      recipients: {
        [CLIENT_RECIPIENT_TYPE]: {
          userId: referrerUserId,
        },
      },
      pushPayload: {
        title: "Referral reward earned",
        body: `${formattedAmount} has been added to your referral balance.`,
        data: createReferralsNotificationData(NotificationType.REFERRAL_REWARD_RELEASED),
      },
      templateData: {
        templateKind: PUSH_ONLY_TEMPLATE_KIND,
        subject: "Referral reward earned",
      },
    };
  }

  buildPayoutStatusChangedJobData({
    payoutTransactionId,
    bookingId,
    bookingReference,
    status,
    amount,
    failureReason,
    fleetOwner,
  }: PayoutStatusChangedNotificationParams): NotificationJobData | null {
    const succeeded = status === "PAID_OUT";
    const recipientName = succeeded ? (fleetOwner.name ?? "Fleet Owner") : "Operations team";
    const channels = succeeded
      ? this.recipientChannelResolver
          .resolve({
            audience: NotificationAudience.FLEET_OWNER,
            email: fleetOwner.email,
            phoneNumber: fleetOwner.phoneNumber ?? undefined,
          })
          .filter(
            (channel) => channel !== NotificationChannel.WHATSAPP || this.payoutWhatsAppEnabled,
          )
      : [NotificationChannel.EMAIL];

    if (channels.length === 0) {
      return null;
    }

    const recipientType = succeeded ? FLEET_OWNER_RECIPIENT_TYPE : OPERATIONS_RECIPIENT_TYPE;

    return {
      id: `payout-status-${payoutTransactionId}-${status.toLowerCase()}`,
      type: NotificationType.PAYOUT_STATUS_CHANGED,
      audience: succeeded ? NotificationAudience.FLEET_OWNER : NotificationAudience.OPERATIONS,
      channels,
      bookingId,
      recipients: {
        [recipientType]: succeeded
          ? {
              userId: fleetOwner.userId,
              email: fleetOwner.email,
              phoneNumber: fleetOwner.phoneNumber ?? undefined,
            }
          : {
              email: this.operationsEmail,
            },
      },
      templateData: {
        templateKind: PAYOUT_STATUS_TEMPLATE_KIND,
        subject: succeeded
          ? `Payout sent for booking ${bookingReference}`
          : `Payout failed for booking ${bookingReference}`,
        status,
        recipientName,
        amount: formatCurrency(amount),
        bookingReference,
        payoutTransactionId,
        failureReason,
      },
    };
  }

  async buildBookingExtensionConfirmedJobData(
    extension: ExtensionWithNotificationRelations,
  ): Promise<NotificationJobData | null> {
    const booking = extension.bookingLeg.booking;
    const bookingDetails = normaliseBookingDetails(booking);
    const extensionDetails = normaliseExtensionDetails(extension);
    const userId = booking.userId ?? booking.user?.id ?? undefined;
    const channels = this.recipientChannelResolver.resolve({
      audience: NotificationAudience.CUSTOMER,
      email: bookingDetails.customerEmail,
      phoneNumber: bookingDetails.customerPhone,
      userId,
    });

    if (channels.length === 0) {
      return null;
    }

    return {
      id: `booking-extension-confirmed-${extension.id}`,
      type: NotificationType.BOOKING_EXTENSION_CONFIRMED,
      audience: NotificationAudience.CUSTOMER,
      channels,
      bookingId: booking.id,
      recipients: {
        [CLIENT_RECIPIENT_TYPE]: {
          userId,
          email: bookingDetails.customerEmail,
          phoneNumber: bookingDetails.customerPhone,
        },
      },
      pushPayload: {
        title: "Booking extension confirmed",
        body: `Your booking has been extended by ${extensionDetails.extensionHours} hour${extensionDetails.extensionHours === 1 ? "" : "s"}.`,
        data: createBookingNotificationData(
          NotificationType.BOOKING_EXTENSION_CONFIRMED,
          booking.id,
        ),
      },
      templateData: {
        templateKind: BOOKING_EXTENSION_CONFIRMED_TEMPLATE_KIND,
        ...bookingDetails,
        legDate: extensionDetails.legDate,
        extensionHours: extensionDetails.extensionHours,
        from: extensionDetails.from,
        to: extensionDetails.to,
        subject: "Booking Extension Confirmed",
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
              data: createBookingNotificationData(
                NotificationType.BOOKING_CANCELLED,
                bookingDetails.id,
              ),
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
              data: createBookingNotificationData(
                NotificationType.BOOKING_CANCELLED,
                bookingDetails.id,
              ),
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

  buildReviewReceivedJobData(params: ReviewReceivedNotificationParams): {
    owner: NotificationJobData;
    chauffeur: NotificationJobData;
  } {
    const ownerJobData: NotificationJobData = {
      id: `review-received-owner-${params.reviewId}`,
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
      id: `review-received-chauffeur-${params.reviewId}`,
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

    return { owner: ownerJobData, chauffeur: chauffeurJobData };
  }

  buildFlightUpdateJobData({
    statusEventId,
    booking,
    recipientType,
    type,
    title,
    body,
    flightNumber,
    expectedArrival,
    pickupActivationTime,
    arrivalLocation,
  }: {
    statusEventId: string;
    booking: BookingWithRelations;
    recipientType: RecipientType;
    type: FlightNotificationType;
    title: string;
    body: string;
    flightNumber: string;
    expectedArrival: string;
    pickupActivationTime: string;
    arrivalLocation: string;
  }): NotificationJobData | null {
    const recipient = this.getFlightUpdateRecipient(booking, recipientType);
    if (!recipient) {
      return null;
    }

    let audience = NotificationAudience.CHAUFFEUR;
    if (recipientType === CLIENT_RECIPIENT_TYPE) {
      audience = NotificationAudience.CUSTOMER;
    } else if (recipientType === FLEET_OWNER_RECIPIENT_TYPE) {
      audience = NotificationAudience.FLEET_OWNER;
    }
    const channels =
      audience === NotificationAudience.CUSTOMER
        ? [NotificationChannel.PUSH]
        : this.recipientChannelResolver
            .resolve({
              audience,
              email: recipient.email,
              phoneNumber: recipient.phoneNumber,
              userId: recipient.userId,
            })
            .filter(
              (channel) => channel !== NotificationChannel.WHATSAPP || this.flightWhatsAppEnabled,
            );
    if (channels.length === 0) {
      return null;
    }

    return {
      id: `${type}-${statusEventId}-${booking.id}-${audience}-${recipient.userId}`,
      type,
      audience,
      channels,
      bookingId: booking.id,
      recipients: {
        [recipientType]: recipient,
      },
      pushPayload:
        audience === NotificationAudience.CUSTOMER
          ? {
              title,
              body,
              data: createBookingNotificationData(type, booking.id),
            }
          : undefined,
      templateData: {
        templateKind: FLIGHT_UPDATE_TEMPLATE_KIND,
        subject: title,
        recipientName: recipient.name,
        flightNumber,
        bookingReference: booking.bookingReference,
        updateTitle: title,
        updateBody: body,
        expectedArrival,
        pickupActivationTime,
        arrivalLocation,
      },
    };
  }

  private getFlightUpdateRecipient(
    booking: BookingWithRelations,
    recipientType: RecipientType,
  ): { userId: string; name: string; email?: string; phoneNumber?: string } | null {
    if (recipientType === CLIENT_RECIPIENT_TYPE) {
      const userId = booking.userId ?? booking.user?.id;
      if (!userId) {
        return null;
      }
      return {
        userId,
        name: booking.user?.name ?? "Customer",
      };
    }

    const user =
      recipientType === FLEET_OWNER_RECIPIENT_TYPE ? booking.car.owner : booking.chauffeur;
    if (!user) {
      return null;
    }

    return {
      userId: user.id,
      name:
        user.name ?? (recipientType === FLEET_OWNER_RECIPIENT_TYPE ? "Fleet owner" : "Chauffeur"),
      email: user.email,
      phoneNumber: user.phoneNumber ?? undefined,
    };
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
        data: createBookingNotificationData(type, bookingLegDetails.bookingId),
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
