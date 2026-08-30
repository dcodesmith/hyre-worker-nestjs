import { Injectable } from "@nestjs/common";
import { BookingStatus, type Payment, PaymentStatus, type Prisma } from "@prisma/client";
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
import { BookingReservationService } from "./booking-reservation.service";

@Injectable()
export class ExtensionConfirmationService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly logger: PinoLogger,
    private readonly notificationOutboxService: NotificationOutboxService,
    private readonly bookingExtensionConfirmedHandler: BookingExtensionConfirmedHandler,
    private readonly bookingReservationService: BookingReservationService,
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

    const confirmation = await this.databaseService
      .$transaction(async (tx) => {
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

        const currentExtension = await tx.extension.findUnique({
          where: { id: extensionId },
          select: {
            bookingLegId: true,
            extensionEndTime: true,
            extensionStartTime: true,
            paymentId: true,
            paymentStatus: true,
            status: true,
          },
        });
        if (!currentExtension) return null;
        if (
          currentExtension.status === "ACTIVE" &&
          currentExtension.paymentStatus === PaymentStatus.PAID
        ) {
          return currentExtension.paymentId === payment.id
            ? ({ kind: "already-confirmed" } as const)
            : null;
        }

        const parentBooking = await tx.booking.findUnique({
          where: { id: bookingId },
          select: { status: true },
        });
        if (
          !(await this.canActivateExtension(
            tx,
            extensionId,
            currentExtension,
            parentBooking?.status,
          ))
        ) {
          return null;
        }

        const updateResult = await tx.extension.updateMany({
          where: {
            id: extensionId,
            status: { in: ["PENDING", "CANCELLED"] },
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

        return { kind: "confirmed", extension } as const;
      })
      .catch((error: unknown) => {
        if (this.bookingReservationService.isOverlapConstraintViolation(error)) {
          this.logger.warn(
            { extensionId, paymentId: payment.id },
            "Paid extension could not be activated because its window is no longer available",
          );
          return null;
        }
        throw error;
      });

    if (!confirmation) {
      this.logger.info(
        {
          extensionId: payment.extensionId,
          paymentId: payment.id,
        },
        "Extension is already confirmed or not found, skipping",
      );
      return false;
    }

    if (confirmation.kind === "already-confirmed") {
      return true;
    }

    const { extension: updatedExtension } = confirmation;
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

  private async canActivateExtension(
    tx: Prisma.TransactionClient,
    extensionId: string,
    extension: {
      bookingLegId: string;
      extensionEndTime: Date;
      extensionStartTime: Date;
      status: string;
    },
    parentStatus: BookingStatus | undefined,
  ): Promise<boolean> {
    if (parentStatus !== BookingStatus.CONFIRMED && parentStatus !== BookingStatus.ACTIVE) {
      return false;
    }
    if (extension.status !== "CANCELLED") return true;

    const replacement = await tx.extension.findFirst({
      where: {
        id: { not: extensionId },
        bookingLegId: extension.bookingLegId,
        extensionStartTime: { lt: extension.extensionEndTime },
        extensionEndTime: { gt: extension.extensionStartTime },
        OR: [
          {
            status: "PENDING",
            paymentStatus: PaymentStatus.UNPAID,
          },
          {
            status: "ACTIVE",
            paymentStatus: PaymentStatus.PAID,
          },
        ],
      },
      select: { id: true },
    });
    return replacement === null;
  }
}
