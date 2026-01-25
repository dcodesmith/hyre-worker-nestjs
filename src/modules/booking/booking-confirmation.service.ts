import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import { BookingStatus, PaymentStatus, type Payment } from "@prisma/client";
import { Queue } from "bullmq";
import { NOTIFICATIONS_QUEUE } from "../../config/constants";
import { normaliseBookingDetails } from "../../shared/helper";
import type { BookingWithRelations } from "../../types";
import { DatabaseService } from "../database/database.service";
import {
  CLIENT_RECIPIENT_TYPE,
  DEFAULT_CHANNELS,
  SEND_NOTIFICATION_JOB_NAME,
} from "../notification/notification.const";
import { NotificationType, type NotificationJobData } from "../notification/notification.interface";

/**
 * Service for confirming bookings after successful payment.
 *
 * This service handles:
 * - Updating booking status from PENDING to CONFIRMED
 * - Updating booking payment status to PAID
 * - Queueing notifications to inform the customer
 */
@Injectable()
export class BookingConfirmationService {
  private readonly logger = new Logger(BookingConfirmationService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    @InjectQueue(NOTIFICATIONS_QUEUE)
    private readonly notificationQueue: Queue<NotificationJobData>,
  ) {}

  /**
   * Confirm a booking after successful payment verification.
   *
   * Called by PaymentWebhookService when a charge.completed webhook
   * is verified as successful.
   *
   * @param payment - The payment record that was just confirmed
   * @returns true if booking was confirmed, false if confirmation was skipped
   */
  async confirmFromPayment(payment: Payment): Promise<boolean> {
    const { bookingId, txRef } = payment;

    if (!bookingId) {
      this.logger.warn("Payment has no associated booking, skipping confirmation", {
        paymentId: payment.id,
        txRef,
      });
      return false;
    }

    // Fetch booking with all relations needed for notification
    const booking = await this.databaseService.booking.findUnique({
      where: { id: bookingId },
      include: {
        chauffeur: true,
        user: true,
        car: { include: { owner: true } },
        legs: { include: { extensions: true } },
      },
    });

    if (!booking) {
      this.logger.warn("Booking not found for payment", {
        bookingId,
        paymentId: payment.id,
        txRef,
      });
      return false;
    }

    // Only confirm PENDING bookings - other states should not be modified
    if (booking.status !== BookingStatus.PENDING) {
      this.logger.log("Booking not in PENDING status, skipping confirmation", {
        bookingId,
        currentStatus: booking.status,
        txRef,
      });
      return false;
    }

    // Confirm the booking
    await this.databaseService.booking.update({
      where: { id: bookingId },
      data: {
        status: BookingStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
      },
    });

    this.logger.log("Booking confirmed after payment", {
      bookingId,
      oldStatus: booking.status,
      newStatus: BookingStatus.CONFIRMED,
      paymentId: payment.id,
      txRef,
    });

    // Queue notification asynchronously (don't block webhook response)
    await this.queueBookingConfirmedNotification(booking as BookingWithRelations);

    return true;
  }

  /**
   * Queue a booking confirmation notification.
   * Uses the notification queue to avoid blocking the webhook handler.
   */
  private async queueBookingConfirmedNotification(booking: BookingWithRelations): Promise<void> {
    try {
      const bookingDetails = normaliseBookingDetails(booking);

      const jobData: NotificationJobData = {
        id: `booking-confirmed-${booking.id}-${Date.now()}`,
        type: NotificationType.BOOKING_CONFIRMED,
        channels: DEFAULT_CHANNELS,
        bookingId: booking.id,
        recipients: {
          [CLIENT_RECIPIENT_TYPE]: {
            email: bookingDetails.customerEmail,
            phoneNumber: bookingDetails.customerPhone,
          },
        },
        templateData: {
          ...bookingDetails,
          subject: "Your booking is confirmed!",
        },
      };

      await this.notificationQueue.add(SEND_NOTIFICATION_JOB_NAME, jobData, { priority: 1 });

      this.logger.log("Queued booking confirmation notification", {
        bookingId: booking.id,
        notificationId: jobData.id,
      });
    } catch (error) {
      // Log but don't throw - notification failure shouldn't fail the confirmation
      this.logger.error("Failed to queue booking confirmation notification", {
        bookingId: booking.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
