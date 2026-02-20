import { Injectable, Logger } from "@nestjs/common";
import { BookingStatus, PaymentStatus, Status } from "@prisma/client";
import type { BookingWithRelations } from "../../types";
import { DatabaseService } from "../database/database.service";
import { NotificationService } from "../notification/notification.service";
import {
  BookingCancellationFailedException,
  BookingException,
  BookingNotCancellableException,
  BookingNotFoundException,
} from "./booking.error";

@Injectable()
export class BookingCancellationService {
  private readonly logger = new Logger(BookingCancellationService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly notificationService: NotificationService,
  ) {}

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
            paymentStatus:
              existingBooking.paymentStatus === PaymentStatus.PAID
                ? PaymentStatus.REFUND_PROCESSING
                : existingBooking.paymentStatus,
            cancelledAt: new Date(),
            cancellationReason: reason,
            referralCreditsReserved: 0,
            ...(existingBooking.paymentStatus === PaymentStatus.PAID
              ? { referralCreditsUsed: 0 }
              : {}),
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

        return updatedBooking;
      });

      await this.queueCancellationNotification(updatedBooking);

      return updatedBooking;
    } catch (error) {
      if (error instanceof BookingException) {
        throw error;
      }

      this.logger.error("Failed to cancel booking", {
        bookingId,
        userId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw new BookingCancellationFailedException();
    }
  }

  private async queueCancellationNotification(booking: BookingWithRelations): Promise<void> {
    try {
      await this.notificationService.queueBookingCancellationNotifications(booking);
    } catch (error) {
      this.logger.error("Failed to queue cancellation notification", {
        bookingId: booking.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
