import { Injectable } from "@nestjs/common";
import { BookingStatus, type Payment, PaymentStatus } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import {
  DatabaseService,
  lockBookingLegRow,
  lockBookingRow,
  lockCarRow,
  lockExtensionRow,
} from "../database/database.service";
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
    const extensionId = payment.extensionId;
    if (!extensionId) {
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
      const identity = await tx.extension.findUnique({
        where: { id: extensionId },
        select: {
          bookingLegId: true,
          bookingLeg: {
            select: {
              booking: {
                select: {
                  id: true,
                  carId: true,
                },
              },
            },
          },
        },
      });
      if (!identity) return null;

      const bookingId = identity.bookingLeg.booking.id;
      if (!(await lockCarRow(tx, identity.bookingLeg.booking.carId))) return null;
      if (!(await lockBookingRow(tx, bookingId))) return null;
      if (!(await lockBookingLegRow(tx, identity.bookingLegId))) return null;
      if (!(await lockExtensionRow(tx, extensionId))) return null;

      const parentBooking = await tx.booking.findUnique({
        where: { id: bookingId },
        select: { status: true },
      });
      if (
        parentBooking?.status !== BookingStatus.CONFIRMED &&
        parentBooking?.status !== BookingStatus.ACTIVE
      ) {
        return null;
      }

      const updateResult = await tx.extension.updateMany({
        where: {
          id: extensionId,
          status: "PENDING",
          paymentStatus: PaymentStatus.UNPAID,
        },
        data: {
          paymentId: payment.id,
          paymentStatus: PaymentStatus.PAID,
          status: "ACTIVE",
        },
      });

      const extension = await tx.extension.findUnique({
        where: { id: extensionId },
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
      const bookingUpdateResult = await tx.booking.updateMany({
        where: {
          id: extension.bookingLeg.booking.id,
          endDate: { lt: extension.extensionEndTime },
        },
        data: { endDate: extension.extensionEndTime },
      });
      if (bookingUpdateResult.count > 0) {
        extension.bookingLeg.booking.endDate = extension.extensionEndTime;
      }

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
