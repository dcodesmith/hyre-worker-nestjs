import { Injectable } from "@nestjs/common";
import { BookingStatus, PaymentStatus, type Prisma, Status } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { DatabaseService, lockCarRow } from "../database/database.service";
import { BookingCancellationHandler } from "../notification/handlers/booking-cancellation.handler";
import { NotificationOutboxService } from "../notification/notification-outbox.service";
import {
  BookingCancellationFailedException,
  BookingException,
  BookingNotFoundException,
  BookingStatusNotModifiableException,
  ExtensionPaymentPendingException,
} from "./booking.error";
import { BookingEligibilityService } from "./booking-eligibility.service";
import { getDatabaseNow } from "./booking-modification-policy.helper";
import { BookingModificationPolicyService } from "./booking-modification-policy.service";
import { findPendingExtensionLegId } from "./extension-reservation.service";

const CANCELLED_BOOKING_REFERRAL_REASON = "BOOKING_CANCELLED";

@Injectable()
export class BookingCancellationService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly notificationOutboxService: NotificationOutboxService,
    private readonly bookingCancellationHandler: BookingCancellationHandler,
    private readonly bookingEligibilityService: BookingEligibilityService,
    private readonly bookingModificationPolicyService: BookingModificationPolicyService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(BookingCancellationService.name);
  }

  async cancelBooking(bookingId: string, userId: string, reason: string) {
    try {
      const updatedBooking = await this.databaseService.$transaction(async (tx) => {
        const existingBooking = await tx.booking.findUnique({
          where: { id: bookingId },
          select: {
            id: true,
            userId: true,
            status: true,
            paymentStatus: true,
            startDate: true,
            carId: true,
          },
        });

        if (!existingBooking?.id || existingBooking.userId !== userId) {
          throw new BookingNotFoundException();
        }

        this.bookingModificationPolicyService.assertCancellableStatus(existingBooking);
        const carExists = await lockCarRow(tx, existingBooking.carId);
        if (!carExists) {
          throw new BookingNotFoundException();
        }

        const bookingLocked = await this.lockCancellableBookingState(
          tx,
          bookingId,
          userId,
          existingBooking.startDate,
        );
        if (!bookingLocked) {
          throw new BookingStatusNotModifiableException(
            "cancel",
            "Booking state changed during cancellation. Please retry",
          );
        }
        const pendingExtensionLegId = await findPendingExtensionLegId(tx, bookingId);
        if (pendingExtensionLegId) {
          throw new ExtensionPaymentPendingException(pendingExtensionLegId);
        }

        const policyNow = await getDatabaseNow(tx);
        this.bookingModificationPolicyService.assertCanCancel(existingBooking, policyNow);
        const modificationCutoffAt = this.bookingModificationPolicyService.getModificationCutoffAt(
          existingBooking.startDate,
        );
        const updated = await tx.$queryRaw<Array<{ id: string }>>`
          UPDATE "Booking"
          SET "status" = ${BookingStatus.CANCELLED}::"BookingStatus",
              "paymentStatus" = ${PaymentStatus.REFUND_PROCESSING}::"PaymentStatus",
              "cancelledAt" = timezone('UTC', clock_timestamp()),
              "cancellationReason" = ${reason},
              "referralCreditsReserved" = 0,
              "referralCreditsUsed" = 0,
              "updatedAt" = timezone('UTC', clock_timestamp())
          WHERE "id" = ${bookingId}
            AND "userId" = ${userId}
            AND "status" = ${BookingStatus.CONFIRMED}::"BookingStatus"
            AND "paymentStatus" = ${PaymentStatus.PAID}::"PaymentStatus"
            AND "startDate" = ${existingBooking.startDate}
            AND clock_timestamp() < ${modificationCutoffAt}
          RETURNING "id"
        `;
        if (updated.length === 0) {
          const rejectionNow = await getDatabaseNow(tx);
          this.bookingModificationPolicyService.assertWithinWindow(
            existingBooking.startDate,
            rejectionNow,
          );
          throw new BookingStatusNotModifiableException(
            "cancel",
            "Booking state changed during cancellation. Please retry",
          );
        }

        const updatedBooking = await tx.booking.findUniqueOrThrow({
          where: { id: bookingId },
          include: {
            user: true,
            chauffeur: true,
            legs: { include: { extensions: true } },
            car: { include: { owner: { include: { chauffeurs: true } } } },
          },
        });

        await this.bookingEligibilityService.reversePendingReferralRewards(
          tx,
          bookingId,
          CANCELLED_BOOKING_REFERRAL_REASON,
        );

        await tx.car.update({
          where: { id: existingBooking.carId },
          data: { status: Status.AVAILABLE },
        });

        // Cancellation notifications go through the outbox in the same tx
        // as the status flip — they commit atomically with the cancellation
        // (architectural review, Issue 4A).
        await this.notificationOutboxService.create(
          this.bookingCancellationHandler,
          { booking: updatedBooking },
          tx,
        );

        const responseNow = await getDatabaseNow(tx);
        return {
          ...updatedBooking,
          ...this.bookingModificationPolicyService.getEligibility(
            updatedBooking,
            true,
            responseNow,
          ),
        };
      });

      return updatedBooking;
    } catch (error) {
      if (error instanceof BookingException) {
        throw error;
      }

      this.logger.error(
        {
          bookingId,
          userId,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        "Failed to cancel booking",
      );
      throw new BookingCancellationFailedException();
    }
  }

  private async lockCancellableBookingState(
    tx: Prisma.TransactionClient,
    bookingId: string,
    userId: string,
    startDate: Date,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT booking."id"
      FROM "Booking" AS booking
      WHERE booking."id" = ${bookingId}
        AND booking."userId" = ${userId}
        AND booking."status" = ${BookingStatus.CONFIRMED}::"BookingStatus"
        AND booking."paymentStatus" = ${PaymentStatus.PAID}::"PaymentStatus"
        AND booking."startDate" = ${startDate}
      FOR UPDATE OF booking
    `;

    return rows.length > 0;
  }
}
