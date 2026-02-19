import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import { type Payment, PaymentStatus } from "@prisma/client";
import { Queue } from "bullmq";
import { NOTIFICATIONS_QUEUE } from "../../config/constants";
import { normaliseBookingDetails, normaliseExtensionDetails } from "../../shared/helper";
import { DatabaseService } from "../database/database.service";
import {
  CLIENT_RECIPIENT_TYPE,
  SEND_NOTIFICATION_JOB_NAME,
} from "../notification/notification.const";
import {
  NotificationChannel,
  type NotificationJobData,
  NotificationType,
} from "../notification/notification.interface";
import { BOOKING_EXTENSION_CONFIRMED_TEMPLATE_KIND } from "../notification/template-data.interface";

@Injectable()
export class ExtensionConfirmationService {
  private readonly logger = new Logger(ExtensionConfirmationService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    @InjectQueue(NOTIFICATIONS_QUEUE)
    private readonly notificationQueue: Queue<NotificationJobData>,
  ) {}

  async confirmFromPayment(payment: Payment): Promise<boolean> {
    if (!payment.extensionId) {
      this.logger.warn("Payment has no associated extension, skipping confirmation", {
        paymentId: payment.id,
        txRef: payment.txRef,
      });
      return false;
    }

    const updatedExtension = await this.databaseService.$transaction(async (tx) => {
      const updateResult = await tx.extension.updateMany({
        where: { id: payment.extensionId, status: "PENDING" },
        data: {
          paymentId: payment.id,
          paymentStatus: PaymentStatus.PAID,
          status: "ACTIVE",
        },
      });

      const extension = await tx.extension.findUnique({
        where: { id: payment.extensionId },
        include: {
          bookingLeg: {
            include: {
              booking: {
                include: {
                  user: true,
                  car: { include: { owner: true } },
                  chauffeur: true,
                  legs: { include: { extensions: true } },
                },
              },
            },
          },
        },
      });

      if (!extension) {
        return null;
      }

      if (updateResult.count === 0 && extension.status !== "ACTIVE") {
        return null;
      }

      // Advance legEndTime only if this extension pushes the window forward.
      // Using updateMany with a time guard keeps this safe under concurrent confirmations.
      await tx.bookingLeg.updateMany({
        where: {
          id: extension.bookingLegId,
          legEndTime: { lt: extension.extensionEndTime },
        },
        data: { legEndTime: extension.extensionEndTime },
      });

      return extension;
    });

    if (!updatedExtension) {
      this.logger.log("Extension is already confirmed or not found, skipping", {
        extensionId: payment.extensionId,
        paymentId: payment.id,
      });
      return false;
    }

    const bookingDetails = normaliseBookingDetails(updatedExtension.bookingLeg.booking);
    const extensionDetails = normaliseExtensionDetails(updatedExtension);

    const notificationJobId = `booking-extension-confirmed-${updatedExtension.id}`;
    await this.notificationQueue.add(
      SEND_NOTIFICATION_JOB_NAME,
      {
        id: notificationJobId,
        type: NotificationType.BOOKING_EXTENSION_CONFIRMED,
        channels: [NotificationChannel.EMAIL],
        bookingId: updatedExtension.bookingLeg.booking.id,
        recipients: {
          [CLIENT_RECIPIENT_TYPE]: {
            email: bookingDetails.customerEmail,
            phoneNumber: bookingDetails.customerPhone,
          },
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
      },
      { jobId: notificationJobId },
    );

    this.logger.log("Extension confirmed after payment", {
      extensionId: updatedExtension.id,
      paymentId: payment.id,
      txRef: payment.txRef,
    });

    return true;
  }
}
