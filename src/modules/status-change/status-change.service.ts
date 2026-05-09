import { Injectable } from "@nestjs/common";
import { BookingStatus, BookingType, PaymentStatus, Status } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import type { BookingWithRelations } from "../../types";
import { DatabaseService } from "../database/database.service";
import { BookingStatusChangedHandler } from "../notification/handlers/booking-status-changed.handler";
import {
  NotificationOutboxService,
  type NotificationOutboxTransactionClient,
} from "../notification/notification-outbox.service";
import { PaymentService } from "../payment/payment.service";
import { ReferralService } from "../referral/referral.service";
import {
  ActiveToCompletedUpdateFailedException,
  AirportBookingActivationFailedException,
  ConfirmedToActiveUpdateFailedException,
  StatusChangeException,
} from "./status-change.error";

@Injectable()
export class StatusChangeService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly notificationOutboxService: NotificationOutboxService,
    private readonly bookingStatusChangedHandler: BookingStatusChangedHandler,
    private readonly paymentService: PaymentService,
    private readonly referralService: ReferralService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(StatusChangeService.name);
  }

  private getCurrentUtcHourWindow(): { gte: Date; lte: Date } {
    const now = new Date();
    const gte = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        now.getUTCHours(),
        0,
        0,
        0,
      ),
    );
    const lte = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        now.getUTCHours(),
        59,
        59,
        999,
      ),
    );
    return { gte, lte };
  }

  async updateBookingsFromConfirmedToActive(timestamp?: string) {
    try {
      const startDate = timestamp ? { lt: new Date(timestamp) } : this.getCurrentUtcHourWindow();

      // Find all confirmed bookings where start date falls within the current UTC hour window
      const bookingsToUpdate = await this.databaseService.booking.findMany({
        where: {
          status: BookingStatus.CONFIRMED,
          paymentStatus: PaymentStatus.PAID,
          type: { not: BookingType.AIRPORT_PICKUP },

          chauffeurId: { not: null },
          startDate,
          car: {
            status: Status.BOOKED,
          },
        },
        include: {
          car: { include: { owner: true } },
          user: true,
          chauffeur: true,
          legs: { include: { extensions: true } },
        },
      });

      if (bookingsToUpdate.length === 0) {
        this.logger.info("No bookings to update from confirmed to active");
        return "No bookings to update";
      }

      // Perform all updates in a transaction for atomicity
      await this.databaseService.$transaction(async (tx) => {
        for (const booking of bookingsToUpdate) {
          const oldStatus = booking.status;

          const updatedBooking = await tx.booking.update({
            where: { id: booking.id },
            data: { status: BookingStatus.ACTIVE },
            include: {
              car: { include: { owner: true } },
              user: true,
              chauffeur: true,
              legs: { include: { extensions: true } },
            },
          });

          await this.queueStatusNotification(
            booking.id,
            updatedBooking,
            oldStatus,
            BookingStatus.ACTIVE,
            false,
            tx,
          );
        }
      });

      return `Updated ${bookingsToUpdate.length} bookings from confirmed to active`;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown error";
      const wrappedError =
        error instanceof StatusChangeException
          ? error
          : new ConfirmedToActiveUpdateFailedException(reason);
      this.logger.error({ error: wrappedError.message }, "Confirmed to active update failed");
      throw wrappedError;
    }
  }

  async activateAirportBooking(bookingId: string, activationAt?: string) {
    if (typeof bookingId !== "string" || bookingId.trim().length === 0) {
      const wrappedError = new AirportBookingActivationFailedException(
        "unknown",
        "Invalid bookingId for airport activation",
      );
      this.logger.error(
        {
          error: wrappedError.message,
          cause: "Invalid bookingId for airport activation",
        },
        "Airport booking activation failed",
      );
      throw wrappedError;
    }

    const normalizedBookingId = bookingId.trim();

    try {
      const updatedCount = await this.databaseService.booking.updateMany({
        where: {
          id: normalizedBookingId,
          type: BookingType.AIRPORT_PICKUP,
          status: BookingStatus.CONFIRMED,
          paymentStatus: PaymentStatus.PAID,
          deletedAt: null,
          chauffeurId: { not: null },
          car: { status: Status.BOOKED },
        },
        data: { status: BookingStatus.ACTIVE },
      });

      if (updatedCount.count === 0) {
        return `Skipped airport activation for ${normalizedBookingId}: booking not eligible`;
      }

      const updatedBooking = await this.databaseService.booking.findUnique({
        where: { id: normalizedBookingId },
        include: {
          car: { include: { owner: true } },
          user: true,
          chauffeur: true,
          legs: { include: { extensions: true } },
        },
      });

      if (!updatedBooking) {
        return `Skipped airport activation for ${normalizedBookingId}: booking not found`;
      }

      await this.queueStatusNotification(
        updatedBooking.id,
        updatedBooking,
        BookingStatus.CONFIRMED,
        BookingStatus.ACTIVE,
      );

      this.logger.info(
        { bookingId: normalizedBookingId, activationAt },
        "Airport booking activated",
      );

      return `Activated airport booking ${normalizedBookingId}`;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const wrappedError =
        error instanceof StatusChangeException
          ? error
          : new AirportBookingActivationFailedException(normalizedBookingId, reason);
      this.logger.error({ error: wrappedError.message }, "Airport booking activation failed");
      throw wrappedError;
    }
  }

  async updateBookingsFromActiveToCompleted(timestamp?: string) {
    try {
      const endDate = timestamp ? { lte: new Date(timestamp) } : this.getCurrentUtcHourWindow();
      // Find all active bookings where end date falls within the current UTC hour window
      // Query for BOOKED cars only - cars with ACTIVE bookings should always be BOOKED
      const bookingsToUpdate = await this.databaseService.booking.findMany({
        where: {
          status: BookingStatus.ACTIVE,
          paymentStatus: PaymentStatus.PAID,
          endDate,
          car: {
            status: Status.BOOKED,
          },
        },
        include: {
          car: { include: { owner: true } },
          user: true,
          chauffeur: true,
          legs: { include: { extensions: true } },
        },
      });

      if (bookingsToUpdate.length === 0) {
        this.logger.info("No bookings to update from active to completed");
        return "No bookings to update";
      }

      for (const booking of bookingsToUpdate) {
        await this.completeActiveBooking(booking);
      }

      return `Updated ${bookingsToUpdate.length} bookings from active to completed`;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const wrappedError =
        error instanceof StatusChangeException
          ? error
          : new ActiveToCompletedUpdateFailedException(reason);
      this.logger.error({ error: wrappedError.message }, "Active to completed update failed");
      throw wrappedError;
    }
  }

  private async completeActiveBooking(booking: {
    id: string;
    status: BookingStatus;
    carId: string;
    endDate: Date;
  }): Promise<void> {
    await this.completeBookingTransaction(booking);
    await this.queuePostCompletionTasks(booking.id);
  }

  private async completeBookingTransaction(booking: {
    id: string;
    status: BookingStatus;
    carId: string;
    endDate: Date;
  }): Promise<void> {
    const oldStatus = booking.status;

    await this.databaseService.$transaction(async (tx) => {
      const updatedBooking = await tx.booking.update({
        where: { id: booking.id },
        data: { status: BookingStatus.COMPLETED },
        include: {
          car: { include: { owner: { include: { bankDetails: true } } } },
          user: true,
          chauffeur: true,
          legs: { include: { extensions: true } },
        },
      });

      const hasUpcomingBooking = await tx.booking.findFirst({
        where: {
          carId: booking.carId,
          status: BookingStatus.CONFIRMED,
          paymentStatus: PaymentStatus.PAID,
          id: { not: booking.id },
          startDate: {
            gte: booking.endDate,
          },
        },
      });

      if (hasUpcomingBooking) {
        this.logger.info(
          {
            carId: booking.carId,
            upcomingBookingId: hasUpcomingBooking.id,
            upcomingBookingStatus: hasUpcomingBooking.status,
          },
          "Car remains BOOKED due to upcoming booking",
        );
      } else {
        await tx.car.update({
          where: { id: booking.carId },
          data: { status: Status.AVAILABLE },
        });
      }

      const existingReview = await tx.review.findUnique({
        where: { bookingId: booking.id },
      });
      const showReviewRequest = !existingReview;

      await this.queueStatusNotification(
        booking.id,
        updatedBooking,
        oldStatus,
        BookingStatus.COMPLETED,
        showReviewRequest,
        tx,
      );
    });
  }

  private async queuePostCompletionTasks(bookingId: string): Promise<void> {
    await this.runNonBlockingPostCompletionTask(
      bookingId,
      "Failed to queue referral processing",
      () => this.referralService.queueReferralProcessing(bookingId),
    );
    await this.runNonBlockingPostCompletionTask(
      bookingId,
      "Failed to queue payout processing",
      () => this.paymentService.queuePayoutForBooking(bookingId),
    );
  }

  private async runNonBlockingPostCompletionTask(
    bookingId: string,
    errorMessage: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    try {
      await operation();
    } catch (error) {
      this.logger.error(
        {
          bookingId,
          error: error instanceof Error ? error.message : String(error),
        },
        errorMessage,
      );
    }
  }

  private async queueStatusNotification(
    bookingId: string,
    booking: BookingWithRelations,
    oldStatus: string,
    newStatus: string,
    showReviewRequest = false,
    tx?: NotificationOutboxTransactionClient,
  ): Promise<void> {
    try {
      await this.notificationOutboxService.create(
        this.bookingStatusChangedHandler,
        { booking, oldStatus, newStatus, showReviewRequest },
        tx,
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error({ bookingId, error: errorMessage }, "Failed to queue status notification");
      // Continue without failing booking status updates
    }
  }
}
