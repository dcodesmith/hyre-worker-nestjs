import { Injectable, Logger } from "@nestjs/common";
import { BookingStatus, PaymentStatus, Status } from "@prisma/client";
import { DatabaseService } from "../database/database.service";
import { NotificationService } from "../notification/notification.service";

@Injectable()
export class StatusChangeService {
  private readonly logger = new Logger(StatusChangeService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly notificationService: NotificationService,
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

  async updateBookingsFromConfirmedToActive() {
    try {
      // Find all confirmed bookings where start date falls within the current UTC hour window

      const bookingsToUpdate = await this.databaseService.booking.findMany({
        where: {
          status: BookingStatus.CONFIRMED,
          paymentStatus: PaymentStatus.PAID,
          chauffeurId: { not: null },
          startDate: this.getCurrentUtcHourWindow(),
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

          // Queue notifications instead of sending directly
          await this.notificationService.queueBookingStatusNotifications(
            updatedBooking,
            oldStatus,
            BookingStatus.ACTIVE,
          );
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

  async updateBookingsFromActiveToCompleted() {
    try {
      // Find all active bookings where end date falls within the current UTC hour window
      const bookingsToUpdate = await this.databaseService.booking.findMany({
        where: {
          status: BookingStatus.ACTIVE,
          paymentStatus: PaymentStatus.PAID,
          endDate: this.getCurrentUtcHourWindow(),
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

          // Free up the car
          await tx.car.update({
            where: { id: booking.carId },
            data: { status: Status.AVAILABLE },
          });

          // Queue notifications instead of sending directly (using fresh updatedBooking)
          await this.notificationService.queueBookingStatusNotifications(
            updatedBooking,
            oldStatus,
            BookingStatus.COMPLETED,
          );
        });
      }

      return `Updated ${bookingsToUpdate.length} bookings from active to completed`;
    } catch (error) {
      this.logger.error(`Error updating booking statuses: ${error}`);
      throw error;
    }
  }
}
