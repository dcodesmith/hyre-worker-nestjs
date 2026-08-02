import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import { EventEmitter2, EventEmitterReadinessWatcher } from "@nestjs/event-emitter";
import {
  BookingReferralStatus,
  BookingStatus,
  type Payment,
  PaymentStatus,
  Prisma,
  Status,
} from "@prisma/client";
import type { Queue } from "bullmq";
import { PinoLogger } from "nestjs-pino";
import { CREATE_FLIGHT_ALERT_JOB, FLIGHT_ALERTS_QUEUE } from "../../config/constants";
import { BOOKING_CONFIRMED_EVENT } from "../../shared/events/airport-activation.events";
import type { BookingWithRelations } from "../../types";
import { DatabaseService, lockCarRow } from "../database/database.service";
import type { FlightAlertJobData } from "../flightaware/flightaware-alert.interface";
import { BookingConfirmedHandler } from "../notification/handlers/booking-confirmed.handler";
import { NotificationOutboxService } from "../notification/notification-outbox.service";
import { CarNotAvailableException } from "./booking.error";
import { BookingValidationService } from "./booking-validation.service";

/**
 * Service for confirming bookings after successful payment.
 *
 * This service handles:
 * - Updating booking status from PENDING to CONFIRMED
 * - Updating booking payment status to PAID
 * - Queueing notifications to inform the customer
 */
@Injectable()
export class BookingConfirmationService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly eventEmitter: EventEmitter2,
    private readonly eventEmitterReadinessWatcher: EventEmitterReadinessWatcher,
    private readonly logger: PinoLogger,
    private readonly notificationOutboxService: NotificationOutboxService,
    private readonly bookingConfirmedHandler: BookingConfirmedHandler,
    private readonly bookingValidationService: BookingValidationService,
    @InjectQueue(FLIGHT_ALERTS_QUEUE)
    private readonly flightAlertQueue: Queue<FlightAlertJobData>,
  ) {
    this.logger.setContext(BookingConfirmationService.name);
  }

  /**
   * Confirm a booking after successful payment verification.
   *
   * Called by PaymentWebhookService when a charge.completed webhook
   * is verified as successful.
   *
   * @param payment - The payment record that was just confirmed
   * @returns true if booking was confirmed, false if confirmation was skipped
   */
  async confirmFromPayment(payment: Payment): Promise<boolean> {
    const { bookingId, txRef } = payment;

    if (!bookingId) {
      this.logger.warn(
        {
          paymentId: payment.id,
          txRef,
        },
        "Payment has no associated booking, skipping confirmation",
      );
      return false;
    }

    const updatedBooking = await this.databaseService.$transaction(async (tx) => {
      const [pendingBooking] = await tx.$queryRaw<
        Array<{
          id: string;
          carId: string;
          startDate: Date;
          endDate: Date;
          status: BookingStatus;
        }>
      >(
        Prisma.sql`
          SELECT id, "carId", "startDate", "endDate", status
          FROM "Booking"
          WHERE id = ${bookingId}
        `,
      );
      if (pendingBooking?.status !== BookingStatus.PENDING) {
        return null;
      }

      const carExists = await lockCarRow(tx, pendingBooking.carId);
      if (!carExists) {
        throw new CarNotAvailableException(
          pendingBooking.carId,
          "The vehicle is no longer available for this paid booking.",
        );
      }
      await this.bookingValidationService.checkCarAvailability(
        {
          carId: pendingBooking.carId,
          startDate: pendingBooking.startDate,
          endDate: pendingBooking.endDate,
          excludeBookingId: pendingBooking.id,
        },
        tx,
      );

      // Atomic conditional update - only updates if booking exists and is still PENDING.
      // This prevents TOCTOU race conditions where status could change between read and update.
      const updateResult = await tx.booking.updateMany({
        where: { id: bookingId, status: BookingStatus.PENDING },
        data: {
          status: BookingStatus.CONFIRMED,
          paymentStatus: PaymentStatus.PAID,
        },
      });

      if (updateResult.count === 0) {
        return null;
      }

      const booking = await tx.booking.findUnique({
        where: { id: bookingId },
        include: {
          chauffeur: true,
          user: true,
          car: { include: { owner: true } },
          legs: { include: { extensions: true } },
        },
      });

      let confirmedBooking = booking;
      if (
        booking?.referralStatus === BookingReferralStatus.RESERVED &&
        booking.userId &&
        booking.referralReferrerUserId
      ) {
        await tx.user.update({
          where: { id: booking.userId },
          data: { referralDiscountUsed: true },
        });
        await tx.booking.update({
          where: { id: booking.id },
          data: { referralStatus: BookingReferralStatus.APPLIED },
        });

        confirmedBooking = {
          ...booking,
          referralStatus: BookingReferralStatus.APPLIED,
        };
      }

      if (confirmedBooking) {
        await this.notificationOutboxService.create(
          this.bookingConfirmedHandler,
          { booking: confirmedBooking },
          tx,
        );
      }

      return confirmedBooking;
    });

    // If no records were updated, booking doesn't exist or is not in PENDING status
    if (!updatedBooking) {
      this.logger.info(
        {
          bookingId,
          paymentId: payment.id,
          txRef,
        },
        "Booking not found or not in PENDING status, skipping confirmation",
      );
      return false;
    }

    this.logger.info(
      {
        bookingId,
        newStatus: BookingStatus.CONFIRMED,
        paymentId: payment.id,
        txRef,
      },
      "Booking confirmed after payment",
    );

    // Update car status to BOOKED to prevent double-booking
    await this.updateCarStatusToBooked(updatedBooking.carId, bookingId);

    void this.queuePaidBookingFlightAlert(updatedBooking);
    await this.emitBookingConfirmedEvent(updatedBooking);

    return true;
  }

  /**
   * Update the car status to BOOKED to prevent double-booking.
   * This is a non-blocking operation - car status update failure should not fail the confirmation.
   */
  private async updateCarStatusToBooked(carId: string, bookingId: string): Promise<void> {
    try {
      await this.databaseService.car.update({
        where: { id: carId },
        data: { status: Status.BOOKED },
      });

      this.logger.info(
        {
          carId,
          bookingId,
          newStatus: Status.BOOKED,
        },
        "Car status updated to BOOKED",
      );
    } catch (error) {
      // Log but don't throw - car status update failure shouldn't fail the confirmation
      // The booking is already confirmed, and the car can be manually updated if needed
      this.logger.error(
        {
          carId,
          bookingId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to update car status to BOOKED",
      );
    }
  }

  private async queuePaidBookingFlightAlert(booking: BookingWithRelations): Promise<void> {
    if (booking.type !== "AIRPORT_PICKUP" || !booking.flightId) {
      return;
    }

    try {
      const flight = await this.databaseService.flight.findUnique({
        where: { id: booking.flightId },
        select: {
          id: true,
          flightNumber: true,
          scheduledDeparture: true,
          originCode: true,
          originTimezone: true,
          destinationCodeIATA: true,
        },
      });
      if (!flight?.scheduledDeparture) {
        this.logger.warn(
          { bookingId: booking.id, flightId: booking.flightId },
          "Paid airport booking has no schedulable flight alert",
        );
        return;
      }

      await this.flightAlertQueue.add(
        CREATE_FLIGHT_ALERT_JOB,
        {
          flightId: flight.id,
          flightNumber: flight.flightNumber,
          departureTime: flight.scheduledDeparture.toISOString(),
          originCode: flight.originCode,
          originTimezone: flight.originTimezone ?? undefined,
          destinationIATA: flight.destinationCodeIATA ?? undefined,
        },
        { jobId: `flight-alert-${flight.id}` },
      );
    } catch (error) {
      this.logger.error(
        {
          bookingId: booking.id,
          flightId: booking.flightId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to queue paid booking flight alert; scheduler will reconcile",
      );
    }
  }

  private async emitBookingConfirmedEvent(booking: BookingWithRelations): Promise<void> {
    if (booking.type !== "AIRPORT_PICKUP") {
      return;
    }

    const activationAt = booking.legs.reduce<Date | null>((earliestLegStartTime, leg) => {
      if (!leg.legStartTime) {
        return earliestLegStartTime;
      }

      if (!earliestLegStartTime || leg.legStartTime < earliestLegStartTime) {
        return leg.legStartTime;
      }

      return earliestLegStartTime;
    }, null);
    if (!activationAt) {
      this.logger.warn(
        {
          bookingId: booking.id,
        },
        "Airport booking has no leg start time; skipping activation schedule",
      );
      return;
    }

    try {
      await this.eventEmitterReadinessWatcher.waitUntilReady();
      // Intentionally fire-and-forget: confirmation flow should not wait for listener processing.
      this.eventEmitter.emit(BOOKING_CONFIRMED_EVENT, {
        bookingId: booking.id,
        bookingType: booking.type,
        activationAt: activationAt.toISOString(),
      });
    } catch (error) {
      this.logger.error(
        {
          bookingId: booking.id,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to emit booking confirmed event",
      );
    }
  }
}
