import { Injectable } from "@nestjs/common";
import { BookingStatus, PaymentStatus, Status } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { DatabaseService } from "../database/database.service";
import { BookingCancellationHandler } from "../notification/handlers/booking-cancellation.handler";
import { NotificationOutboxService } from "../notification/notification-outbox.service";
import {
  BookingCancellationFailedException,
  BookingException,
  BookingNotCancellableException,
  BookingNotFoundException,
} from "./booking.error";

@Injectable()
export class BookingCancellationService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly notificationOutboxService: NotificationOutboxService,
    private readonly bookingCancellationHandler: BookingCancellationHandler,
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
            carId: true,
          },
        });

        if (!existingBooking?.id || existingBooking.userId !== userId) {
          throw new BookingNotFoundException();
        }

        const canCancelBooking =
          existingBooking.status === BookingStatus.CONFIRMED &&
          existingBooking.paymentStatus === PaymentStatus.PAID;

        if (!canCancelBooking) {
          throw new BookingNotCancellableException();
        }

        const updatedBooking = await tx.booking.update({
          where: { id: bookingId },
          data: {
            status: BookingStatus.CANCELLED,
            paymentStatus: PaymentStatus.REFUND_PROCESSING,
            cancelledAt: new Date(),
            cancellationReason: reason,
            referralCreditsReserved: 0,
            referralCreditsUsed: 0,
          },
          include: {
            user: true,
            chauffeur: true,
            legs: { include: { extensions: true } },
            car: { include: { owner: { include: { chauffeurs: true } } } },
          },
        });

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

        return updatedBooking;
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
}
