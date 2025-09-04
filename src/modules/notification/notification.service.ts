import { InjectQueue } from "@nestjs/bull";
import { Injectable, Logger } from "@nestjs/common";
import { Queue } from "bull";
import {
  getCustomerDetails,
  normaliseBookingDetails,
  normaliseBookingLegDetails,
} from "../../shared/helper";
import { BookingLegWithRelations, BookingWithRelations } from "../../types";
import { NotificationChannel, NotificationJobData, NotificationType } from "./notification.types";

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @InjectQueue("notifications") private readonly notificationQueue: Queue<NotificationJobData>,
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
      priority: 1, // High priority for status changes
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
        priority: 2, // Medium priority for reminders
      };

      await this.notificationQueue.add("send-notification", customerJobData, {
        priority: 2,
      });
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
        priority: 2,
      };

      await this.notificationQueue.add("send-notification", chauffeurJobData, {
        priority: 2,
      });
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
