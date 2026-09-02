import { Injectable } from "@nestjs/common";
import { BookingStatus, PaymentAttemptStatus, PaymentStatus, type Prisma } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import {
  DatabaseService,
  lockBookingLegRow,
  lockBookingRow,
  lockCarRow,
  lockExtensionRow,
} from "../database/database.service";
import { BOOKING_PAYMENT_SESSION_DURATION_MS } from "./booking.const";
import { BookingReservationService } from "./booking-reservation.service";

export async function findPendingExtensionLegId(
  tx: Prisma.TransactionClient,
  bookingId: string,
): Promise<string | null> {
  const pending = await tx.extension.findFirst({
    where: {
      bookingLeg: { bookingId },
      status: "PENDING",
      paymentStatus: PaymentStatus.UNPAID,
    },
    select: { bookingLegId: true },
  });
  return pending?.bookingLegId ?? null;
}

@Injectable()
export class ExtensionReservationService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly bookingReservationService: BookingReservationService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ExtensionReservationService.name);
  }

  async claimPaymentSession(
    extensionId: string,
    userId: string,
    paymentIntent: string,
  ): Promise<boolean> {
    const identity = await this.findIdentity(extensionId);
    if (!identity) return false;

    try {
      return await this.databaseService.$transaction(async (tx) => {
        const bookingId = identity.bookingLeg.booking.id;
        if (!(await lockCarRow(tx, identity.bookingLeg.booking.carId))) return false;
        if (!(await lockBookingRow(tx, bookingId))) return false;
        if (!(await lockBookingLegRow(tx, identity.bookingLegId))) return false;
        if (!(await lockExtensionRow(tx, extensionId))) return false;

        const extension = await tx.extension.findUnique({
          where: { id: extensionId },
          select: {
            extensionEndTime: true,
            paymentIntent: true,
            paymentStatus: true,
            status: true,
            bookingLeg: {
              select: {
                booking: {
                  select: {
                    id: true,
                    status: true,
                    userId: true,
                  },
                },
              },
            },
          },
        });
        if (
          extension?.bookingLeg.booking.userId !== userId ||
          (extension?.bookingLeg.booking.status !== BookingStatus.CONFIRMED &&
            extension?.bookingLeg.booking.status !== BookingStatus.ACTIVE) ||
          extension?.status !== "PENDING" ||
          extension?.paymentStatus !== PaymentStatus.UNPAID ||
          extension?.paymentIntent !== null
        ) {
          return false;
        }

        const claimed = await tx.extension.updateMany({
          where: {
            id: extensionId,
            status: "PENDING",
            paymentStatus: PaymentStatus.UNPAID,
            paymentIntent: null,
          },
          data: {
            paymentIntent,
            paymentSessionExpiresAt: new Date(Date.now() + BOOKING_PAYMENT_SESSION_DURATION_MS),
          },
        });
        if (claimed.count !== 1) return false;

        await tx.booking.updateMany({
          where: {
            id: bookingId,
            endDate: { lt: extension.extensionEndTime },
          },
          data: { endDate: extension.extensionEndTime },
        });
        return true;
      });
    } catch (error) {
      if (this.bookingReservationService.isOverlapConstraintViolation(error)) {
        return false;
      }
      throw error;
    }
  }

  async cancelExpiredReservation(extensionId: string): Promise<boolean> {
    const identity = await this.findIdentity(extensionId);
    if (!identity) return false;

    const bookingId = identity.bookingLeg.booking.id;
    const carId = identity.bookingLeg.booking.carId;
    return this.databaseService.$transaction(async (tx) => {
      if (!(await lockCarRow(tx, carId))) return false;
      if (!(await lockBookingRow(tx, bookingId))) return false;
      if (!(await lockBookingLegRow(tx, identity.bookingLegId))) return false;
      if (!(await lockExtensionRow(tx, extensionId))) return false;

      const reservation = await tx.extension.findUnique({
        where: { id: extensionId },
        select: {
          createdAt: true,
          paymentSessionExpiresAt: true,
          paymentStatus: true,
          status: true,
        },
      });
      const now = new Date();
      const orphanedBefore = new Date(now.getTime() - BOOKING_PAYMENT_SESSION_DURATION_MS);
      const expired = reservation?.paymentSessionExpiresAt
        ? reservation.paymentSessionExpiresAt <= now
        : Boolean(reservation?.createdAt && reservation.createdAt <= orphanedBefore);
      if (
        !reservation ||
        reservation.status !== "PENDING" ||
        reservation.paymentStatus !== PaymentStatus.UNPAID ||
        !expired
      ) {
        return false;
      }

      const successfulPayments = await tx.payment.count({
        where: {
          extensionId,
          status: PaymentAttemptStatus.SUCCESSFUL,
        },
      });
      if (successfulPayments > 0) return false;

      const cancelled = await tx.extension.updateMany({
        where: {
          id: extensionId,
          status: "PENDING",
          paymentStatus: PaymentStatus.UNPAID,
        },
        data: { status: "CANCELLED" },
      });
      if (cancelled.count !== 1) return false;

      const bookingLegs = await tx.bookingLeg.findMany({
        where: { bookingId },
        select: {
          legEndTime: true,
          extensions: {
            where: {
              id: { not: extensionId },
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
            select: { extensionEndTime: true },
          },
        },
      });
      const reservedEnd = bookingLegs.reduce(
        (latest, leg) =>
          leg.extensions.reduce(
            (legLatest, extension) =>
              new Date(Math.max(extension.extensionEndTime.getTime(), legLatest.getTime())),
            new Date(Math.max(leg.legEndTime.getTime(), latest.getTime())),
          ),
        new Date(0),
      );
      await tx.booking.update({
        where: { id: bookingId },
        data: { endDate: reservedEnd },
      });

      this.logger.info({ extensionId, bookingId }, "Cancelled expired extension reservation");
      return true;
    });
  }

  private findIdentity(extensionId: string) {
    return this.databaseService.extension.findUnique({
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
  }
}
