import { Injectable, Logger } from "@nestjs/common";
import { BookingStatus, PaymentStatus, Status } from "@prisma/client";
import { DatabaseService } from "../database/database.service";
import { NotificationService } from "../notification/notification.service";
import { PaymentService } from "../payment/payment.service";
import { ReferralService } from "../referral/referral.service";

@Injectable()
export class StatusChangeService {
  private readonly logger = new Logger(StatusChangeService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly notificationService: NotificationService,
    private readonly paymentService: PaymentService,
    private readonly referralService: ReferralService,
  ) {}

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
        this.logger.log("No bookings to update from confirmed to active");
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

          try {
            await this.notificationService.queueBookingStatusNotifications(
              updatedBooking,
              oldStatus,
              BookingStatus.ACTIVE,
            );
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logger.error(
              `Failed to queue status notification for booking ${booking.id}: ${errorMessage}`,
            );
            // Continue without failing the transaction
          }
        }
      });

      return `Updated ${bookingsToUpdate.length} bookings from confirmed to active`;
    } catch (error) {
      this.logger.error(
        `Error updating booking statuses: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
      throw error;
    }
  }

  async updateBookingsFromActiveToCompleted(timestamp?: string) {
    try {
      const endDate = timestamp ? { lt: new Date(timestamp) } : this.getCurrentUtcHourWindow();
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
        this.logger.log("No bookings to update from active to completed");
        return "No bookings to update";
      }

      for (const booking of bookingsToUpdate) {
        const oldStatus = booking.status;

        // Perform all operations in a transaction for atomicity
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

          // Check if there are any upcoming bookings for this car that should keep it booked
          // Look for CONFIRMED or ACTIVE bookings that start after this booking ends
          const hasUpcomingBooking = await tx.booking.findFirst({
            where: {
              carId: booking.carId,
              status: BookingStatus.CONFIRMED,
              paymentStatus: PaymentStatus.PAID,
              id: { not: booking.id },
              startDate: {
                gte: booking.endDate, // Follow-up booking should start after this one ends
              },
            },
          });

          // Only update car status if there's no upcoming booking
          // If hasUpcomingBooking is true, the car should already be BOOKED, so no update needed
          if (!hasUpcomingBooking) {
            await tx.car.update({
              where: { id: booking.carId },
              data: { status: Status.AVAILABLE },
            });
          } else {
            this.logger.log(
              `Car ${booking.carId} remains BOOKED due to upcoming booking ${hasUpcomingBooking.id} (status: ${hasUpcomingBooking.status})`,
            );
          }

          try {
            await this.notificationService.queueBookingStatusNotifications(
              updatedBooking,
              oldStatus,
              BookingStatus.COMPLETED,
            );
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logger.error(
              `Failed to queue status notification for booking ${booking.id}: ${errorMessage}`,
            );
            // Continue without failing the transaction
          }
        });

        try {
          // Queue referral processing OUTSIDE the transaction for better isolation
          // This ensures booking status update is not blocked by referral processing
          await this.referralService.queueReferralProcessing(booking.id);
        } catch (error) {
          this.logger.error(
            `Failed to queue referral processing for booking ${booking.id}: ${error}`,
          );
          // Continue without failing the entire operation
        }

        try {
          // Queue payout processing OUTSIDE the transaction for better isolation
          await this.paymentService.queuePayoutForBooking(booking.id);
        } catch (error) {
          this.logger.error(
            `Failed to queue payout processing for booking ${booking.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          // Do not throw so that other bookings can continue processing
        }
      }

      return `Updated ${bookingsToUpdate.length} bookings from active to completed`;
    } catch (error) {
      this.logger.error(`Error updating booking statuses: ${error}`);
      throw error;
    }
  }
}
