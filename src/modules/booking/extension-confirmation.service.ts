import { Injectable } from "@nestjs/common";
import { type Payment, PaymentStatus } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { DatabaseService } from "../database/database.service";
import { BookingExtensionConfirmedHandler } from "../notification/handlers/booking-extension-confirmed.handler";
import { NotificationOutboxService } from "../notification/notification-outbox.service";

@Injectable()
export class ExtensionConfirmationService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly logger: PinoLogger,
    private readonly notificationOutboxService: NotificationOutboxService,
    private readonly bookingExtensionConfirmedHandler: BookingExtensionConfirmedHandler,
  ) {
    this.logger.setContext(ExtensionConfirmationService.name);
  }

  async confirmFromPayment(payment: Payment): Promise<boolean> {
    if (!payment.extensionId) {
      this.logger.warn(
        {
          paymentId: payment.id,
          txRef: payment.txRef,
        },
        "Payment has no associated extension, skipping confirmation",
      );
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
      await tx.booking.updateMany({
        where: {
          id: extension.bookingLeg.booking.id,
          endDate: { lt: extension.extensionEndTime },
        },
        data: { endDate: extension.extensionEndTime },
      });

      await this.notificationOutboxService.create(
        this.bookingExtensionConfirmedHandler,
        { extension },
        tx,
      );

      return extension;
    });

    if (!updatedExtension) {
      this.logger.info(
        {
          extensionId: payment.extensionId,
          paymentId: payment.id,
        },
        "Extension is already confirmed or not found, skipping",
      );
      return false;
    }

    this.logger.info(
      {
        extensionId: updatedExtension.id,
        paymentId: payment.id,
        txRef: payment.txRef,
      },
      "Extension confirmed after payment",
    );

    return true;
  }
}
