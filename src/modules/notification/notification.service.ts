import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import { Job, JobsOptions, Queue } from "bullmq";
import { NOTIFICATIONS_QUEUE } from "src/config/constants";
import {
  getCustomerDetails,
  normaliseBookingDetails,
  normaliseBookingLegDetails,
} from "../../shared/helper";
import { BookingLegWithRelations, BookingWithRelations } from "../../types";
import {
  CHAUFFEUR_RECIPIENT_TYPE,
  CLIENT_RECIPIENT_TYPE,
  DEFAULT_CHANNELS,
  SEND_NOTIFICATION_JOB_NAME,
  STATUS_CHANGE_JOB_OPTIONS,
} from "./notification.const";
import {
  NotificationChannel,
  NotificationJobData,
  NotificationResult,
  NotificationType,
} from "./notification.interface";
import { RecipientType } from "./template-data.interface";

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
  ): Promise<void> {
    const customerDetails = getCustomerDetails(booking);
    const bookingDetails = normaliseBookingDetails(booking);

    const jobData = this.createStatusChangeJobData({
      booking,
      customerDetails,
      bookingDetails,
      oldStatus,
      newStatus,
    });

    await this.addJobToQueue(jobData, STATUS_CHANGE_JOB_OPTIONS);

    this.logStatusChangeNotification(booking.id, oldStatus, newStatus, jobData.channels);
  }

  /**
   * Queue reminder notifications for a specific booking leg (for both customer and chauffeur).
   */
  async queueBookingReminderNotifications(
    bookingLegDetails: ReturnType<typeof normaliseBookingLegDetails>,
    type: NotificationType.BOOKING_REMINDER_START | NotificationType.BOOKING_REMINDER_END,
  ): Promise<void> {
    await this.queueCustomerReminder(bookingLegDetails, type);
    await this.queueChauffeurReminder(bookingLegDetails, type);

    this.logReminderNotifications(bookingLegDetails, type);
  }

  private createStatusChangeJobData({
    booking,
    customerDetails,
    bookingDetails,
    oldStatus,
    newStatus,
  }: {
    booking: BookingWithRelations;
    customerDetails: ReturnType<typeof getCustomerDetails>;
    bookingDetails: ReturnType<typeof normaliseBookingDetails>;
    oldStatus: string;
    newStatus: string;
  }): NotificationJobData {
    return {
      id: `status-${booking.id}-${Date.now()}`,
      type: NotificationType.BOOKING_STATUS_CHANGE,
      channels: DEFAULT_CHANNELS,
      bookingId: booking.id,
      recipients: {
        [CLIENT_RECIPIENT_TYPE]: {
          email: customerDetails.email,
          phoneNumber: customerDetails.phone_number,
        },
      },
      templateData: {
        ...bookingDetails,
        oldStatus,
        newStatus,
        subject: this.getStatusChangeSubject(newStatus),
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
    const chauffeurEmail = bookingLegDetails.chauffeurEmail;
    const chauffeurPhone = bookingLegDetails.chauffeurPhone;
    const customerEmail = bookingLegDetails.customerEmail;
    const customerPhone = bookingLegDetails.customerPhone;

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
