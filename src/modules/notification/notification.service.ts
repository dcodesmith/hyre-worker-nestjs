import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import { Job, Queue } from "bullmq";
import { NOTIFICATIONS_QUEUE } from "src/config/constants";
import {
  getCustomerDetails,
  normaliseBookingDetails,
  normaliseBookingLegDetails,
} from "../../shared/helper";
import { BookingLegWithRelations, BookingWithRelations } from "../../types";
import {
  DEFAULT_CHANNELS,
  SEND_NOTIFICATION_JOB_NAME,
  STATUS_CHANGE_JOB_OPTIONS,
} from "./notification.const";
import {
  NotificationChannel,
  NotificationJobData,
  NotificationType,
} from "./notification.interface";

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

    const jobData = this.createStatusChangeJobData(
      booking,
      customerDetails,
      bookingDetails,
      oldStatus,
      newStatus,
    );

    await this.addJobToQueue(jobData, STATUS_CHANGE_JOB_OPTIONS);

    this.logStatusChangeNotification(booking.id, oldStatus, newStatus, jobData.channels);
  }

  /**
   * Queue reminder notifications for a specific booking leg (for both customer and chauffeur).
   */
  async queueBookingReminderNotifications(
    bookingLeg: BookingLegWithRelations,
    type: "start" | "end",
  ): Promise<void> {
    const customerDetails = getCustomerDetails(bookingLeg.booking);
    const bookingLegDetails = normaliseBookingLegDetails(bookingLeg);

    await this.queueCustomerReminder(bookingLeg, customerDetails, bookingLegDetails, type);
    await this.queueChauffeurReminder(bookingLeg, bookingLegDetails, type);

    this.logReminderNotifications(bookingLeg, customerDetails, type);
  }

  private createStatusChangeJobData(
    booking: BookingWithRelations,
    customerDetails: ReturnType<typeof getCustomerDetails>, // Inferred type for clarity
    bookingDetails: ReturnType<typeof normaliseBookingDetails>, // Inferred type for clarity
    oldStatus: string,
    newStatus: string,
  ): NotificationJobData {
    return {
      id: `status-${booking.id}-${Date.now()}`,
      type: NotificationType.BOOKING_STATUS_CHANGE,
      channels: DEFAULT_CHANNELS,
      bookingId: booking.id,
      recipients: {
        customer: {
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
    bookingLeg: BookingLegWithRelations,
    customerDetails: ReturnType<typeof getCustomerDetails>,
    bookingLegDetails: ReturnType<typeof normaliseBookingLegDetails>,
    type: "start" | "end",
  ): Promise<void> {
    if (!customerDetails.email && !customerDetails.phone_number) return;

    const customerJobData = this.createCustomerReminderJobData(
      bookingLeg,
      customerDetails,
      bookingLegDetails,
      type,
    );

    await this.addJobToQueue(customerJobData);
  }

  private createCustomerReminderJobData(
    bookingLeg: BookingLegWithRelations,
    customerDetails: ReturnType<typeof getCustomerDetails>,
    bookingLegDetails: ReturnType<typeof normaliseBookingLegDetails>,
    type: "start" | "end",
  ): NotificationJobData {
    return {
      id: `reminder-customer-${bookingLeg.id}-${type}-${Date.now()}`,
      type:
        type === "start"
          ? NotificationType.BOOKING_REMINDER_START
          : NotificationType.BOOKING_REMINDER_END,
      channels: DEFAULT_CHANNELS,
      bookingId: bookingLeg.booking.id,
      recipients: {
        customer: {
          email: customerDetails.email,
          phoneNumber: customerDetails.phone_number,
        },
      },
      templateData: {
        ...bookingLegDetails,
        recipientType: "client",
        subject: this.getReminderSubject(type),
      },
    };
  }

  private async queueChauffeurReminder(
    bookingLeg: BookingLegWithRelations,
    bookingLegDetails: ReturnType<typeof normaliseBookingLegDetails>,
    type: "start" | "end",
  ): Promise<void> {
    const chauffeurEmail = bookingLeg.booking.chauffeur?.email;
    const chauffeurPhone = bookingLeg.booking.chauffeur?.phoneNumber;

    if (!chauffeurEmail && !chauffeurPhone) return;

    const chauffeurJobData = this.createChauffeurReminderJobData(
      bookingLeg,
      bookingLegDetails,
      chauffeurEmail,
      chauffeurPhone,
      type,
    );

    await this.addJobToQueue(chauffeurJobData);
  }

  private createChauffeurReminderJobData(
    bookingLeg: BookingLegWithRelations,
    bookingLegDetails: ReturnType<typeof normaliseBookingLegDetails>,
    chauffeurEmail: string | undefined,
    chauffeurPhone: string | undefined,
    type: "start" | "end",
  ): NotificationJobData {
    return {
      id: `reminder-chauffeur-${bookingLeg.id}-${type}-${Date.now()}`,
      type:
        type === "start"
          ? NotificationType.BOOKING_REMINDER_START
          : NotificationType.BOOKING_REMINDER_END,
      channels: DEFAULT_CHANNELS,
      bookingId: bookingLeg.booking.id,
      recipients: {
        chauffeur: {
          email: chauffeurEmail,
          phoneNumber: chauffeurPhone,
        },
      },
      templateData: {
        ...bookingLegDetails,
        recipientType: "chauffeur",
        subject: this.getChauffeurReminderSubject(type),
      },
    };
  }

  private addJobToQueue(
    jobData: NotificationJobData,
    options?: { priority: number },
  ): Promise<Job<NotificationJobData, any, string>> {
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
    bookingLeg: BookingLegWithRelations,
    customerDetails: ReturnType<typeof getCustomerDetails>,
    type: "start" | "end",
  ): void {
    const chauffeurEmail = bookingLeg.booking.chauffeur?.email;
    const chauffeurPhone = bookingLeg.booking.chauffeur?.phoneNumber;

    this.logger.log("Queued booking reminder notifications", {
      bookingLegId: bookingLeg.id,
      type,
      customerChannels:
        customerDetails.email || customerDetails.phone_number ? ["email", "whatsapp"] : [],
      chauffeurChannels: chauffeurEmail || chauffeurPhone ? ["email", "whatsapp"] : [],
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

  private getReminderSubject(type: "start" | "end"): string {
    return type === "start"
      ? "Booking Reminder - Your service starts in approximately 1 hour"
      : "Booking Reminder - Your service ends in approximately 1 hour";
  }

  private getChauffeurReminderSubject(type: "start" | "end"): string {
    return type === "start"
      ? "Booking Reminder - You have a service starting in approximately 1 hour"
      : "Booking Reminder - Your assigned booking for today ends in approximately 1 hour";
  }
}
