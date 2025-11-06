import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import { Queue } from "bullmq";
import { NOTIFICATIONS_QUEUE } from "src/config/constants";
import {
  getCustomerDetails,
  normaliseBookingDetails,
  normaliseBookingLegDetails,
} from "../../shared/helper";
import { BookingLegWithRelations, BookingWithRelations } from "../../types";
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
   * Queue booking status change notifications
   */
  async queueBookingStatusNotifications(
    booking: BookingWithRelations,
    oldStatus: string,
    newStatus: string,
  ): Promise<void> {
    const customerDetails = getCustomerDetails(booking);
    const bookingDetails = normaliseBookingDetails(booking);

    const jobData: NotificationJobData = {
      id: `status-${booking.id}-${Date.now()}`,
      type: NotificationType.BOOKING_STATUS_CHANGE,
      channels: [NotificationChannel.EMAIL, NotificationChannel.WHATSAPP],
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

    await this.notificationQueue.add("send-notification", jobData, {
      priority: 1,
    });

    this.logger.log("Queued booking status notification", {
      bookingId: booking.id,
      oldStatus,
      newStatus,
      channels: jobData.channels,
    });
  }

  /**
   * Queue booking reminder notifications
   */
  async queueBookingReminderNotifications(
    bookingLeg: BookingLegWithRelations,
    type: "start" | "end",
  ): Promise<void> {
    const customerDetails = getCustomerDetails(bookingLeg.booking);
    const bookingLegDetails = normaliseBookingLegDetails(bookingLeg);

    // Customer notifications
    if (customerDetails.email || customerDetails.phone_number) {
      const customerJobData: NotificationJobData = {
        id: `reminder-customer-${bookingLeg.id}-${type}-${Date.now()}`,
        type:
          type === "start"
            ? NotificationType.BOOKING_REMINDER_START
            : NotificationType.BOOKING_REMINDER_END,
        channels: [NotificationChannel.EMAIL, NotificationChannel.WHATSAPP],
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

      await this.notificationQueue.add("send-notification", customerJobData);
    }

    // Chauffeur notifications
    const chauffeurEmail = bookingLeg.booking.chauffeur?.email;
    const chauffeurPhone = bookingLeg.booking.chauffeur?.phoneNumber;

    if (chauffeurEmail || chauffeurPhone) {
      const chauffeurJobData: NotificationJobData = {
        id: `reminder-chauffeur-${bookingLeg.id}-${type}-${Date.now()}`,
        type:
          type === "start"
            ? NotificationType.BOOKING_REMINDER_START
            : NotificationType.BOOKING_REMINDER_END,
        channels: [NotificationChannel.EMAIL, NotificationChannel.WHATSAPP],
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

      await this.notificationQueue.add("send-notification", chauffeurJobData);
    }

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
