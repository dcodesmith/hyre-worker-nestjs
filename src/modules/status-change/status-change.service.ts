import { Injectable } from "@nestjs/common";
import {
  BookingCompletionSource,
  BookingStatus,
  BookingType,
  DomainOutboxEventType,
  PaymentStatus,
  Prisma,
  Status,
} from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import type { BookingWithRelations } from "../../types";
import { BookingNotFoundException } from "../booking/booking.error";
import { createBookingCompletionToken } from "../booking/booking-completion-token.helper";
import { DatabaseService } from "../database/database.service";
import { DomainOutboxService } from "../domain-outbox/domain-outbox.service";
import { BookingStatusChangedHandler } from "../notification/handlers/booking-status-changed.handler";
import {
  NotificationOutboxService,
  type NotificationOutboxTransactionClient,
} from "../notification/notification-outbox.service";
import {
  ActiveToCompletedUpdateFailedException,
  AirportBookingActivationFailedException,
  ConfirmedToActiveUpdateFailedException,
  StatusChangeException,
} from "./status-change.error";

const AIRPORT_COMPLETION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class StatusChangeService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly notificationOutboxService: NotificationOutboxService,
    private readonly bookingStatusChangedHandler: BookingStatusChangedHandler,
    private readonly domainOutboxService: DomainOutboxService,
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
      const completionTokenExpiresAt = new Date(Date.now() + AIRPORT_COMPLETION_TOKEN_TTL_MS);
      const completionToken = createBookingCompletionToken(
        normalizedBookingId,
        completionTokenExpiresAt,
      );
      const updatedCount = await this.databaseService.booking.updateMany({
        where: {
          id: normalizedBookingId,
          type: BookingType.AIRPORT_PICKUP,
          status: BookingStatus.CONFIRMED,
          paymentStatus: PaymentStatus.PAID,
          deletedAt: null,
          airportScheduleConflictAt: null,
          chauffeurId: { not: null },
          car: { status: Status.BOOKED },
        },
        data: {
          status: BookingStatus.ACTIVE,
          completionTokenHash: completionToken.tokenHash,
          completionTokenExpiresAt,
        },
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
        false,
        undefined,
        true,
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

  async getAirportCompletionDetails(bookingId: string, completionTokenHash: string) {
    const booking = await this.databaseService.booking.findFirst({
      where: {
        id: bookingId,
        type: BookingType.AIRPORT_PICKUP,
        status: { in: [BookingStatus.ACTIVE, BookingStatus.COMPLETED] },
        paymentStatus: PaymentStatus.PAID,
        completionTokenHash,
        completionTokenExpiresAt: { gt: new Date() },
        deletedAt: null,
      },
      include: {
        car: { include: { owner: true } },
        user: true,
        chauffeur: true,
        legs: { include: { extensions: true } },
      },
    });
    if (!booking) {
      throw new BookingNotFoundException();
    }
    return this.toAirportCompletionResponse(booking);
  }

  async completeAirportBookingWithToken(bookingId: string, completionTokenHash: string) {
    return this.completeAirportBooking(bookingId, {
      source: BookingCompletionSource.CHAUFFEUR_LINK,
      completionTokenHash,
    });
  }

  async completeAirportBookingForUser(
    bookingId: string,
    userId: string,
    source: typeof BookingCompletionSource.FLEET_OWNER | typeof BookingCompletionSource.OPERATIONS,
  ) {
    return this.completeAirportBooking(bookingId, { source, userId });
  }

  async updateBookingsFromActiveToCompleted(timestamp?: string) {
    try {
      const endDate = { lte: timestamp ? new Date(timestamp) : new Date() };
      // Query for BOOKED cars only - cars with ACTIVE bookings should always be BOOKED
      const bookingsToUpdate = await this.databaseService.booking.findMany({
        where: {
          status: BookingStatus.ACTIVE,
          paymentStatus: PaymentStatus.PAID,
          type: { not: BookingType.AIRPORT_PICKUP },
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
        await this.databaseService.$transaction((tx) =>
          this.completeBookingTransaction(tx, booking, {
            source: BookingCompletionSource.SCHEDULED,
            completedByUserId: null,
          }),
        );
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

  private async completeAirportBooking(
    bookingId: string,
    input:
      | {
          source: typeof BookingCompletionSource.CHAUFFEUR_LINK;
          completionTokenHash: string;
        }
      | {
          source:
            | typeof BookingCompletionSource.FLEET_OWNER
            | typeof BookingCompletionSource.OPERATIONS;
          userId: string;
        },
  ) {
    return this.databaseService.$transaction(async (tx) => {
      const isChauffeurLink = input.source === BookingCompletionSource.CHAUFFEUR_LINK;
      let accessWhere: Prisma.BookingWhereInput;
      if (isChauffeurLink) {
        accessWhere = {
          status: { in: [BookingStatus.ACTIVE, BookingStatus.COMPLETED] },
          completionTokenHash: input.completionTokenHash,
          completionTokenExpiresAt: { gt: new Date() },
        };
      } else if (input.source === BookingCompletionSource.FLEET_OWNER) {
        accessWhere = {
          status: { in: [BookingStatus.ACTIVE, BookingStatus.COMPLETED] },
          car: { ownerId: input.userId },
        };
      } else {
        accessWhere = {
          status: { in: [BookingStatus.ACTIVE, BookingStatus.COMPLETED] },
        };
      }

      const booking = await tx.booking.findFirst({
        where: {
          id: bookingId,
          type: BookingType.AIRPORT_PICKUP,
          paymentStatus: PaymentStatus.PAID,
          deletedAt: null,
          ...accessWhere,
        },
        include: {
          car: { include: { owner: true } },
          user: true,
          chauffeur: true,
          legs: { include: { extensions: true } },
        },
      });
      if (!booking) {
        throw new BookingNotFoundException();
      }
      if (booking.status === BookingStatus.COMPLETED) {
        return this.toAirportCompletionResponse(booking);
      }

      const updatedBooking = await this.completeBookingTransaction(tx, booking, {
        source: input.source,
        completedByUserId: isChauffeurLink ? booking.chauffeurId : input.userId,
        completionTokenHash: isChauffeurLink ? input.completionTokenHash : undefined,
      });
      if (!updatedBooking) {
        const completedBooking = await tx.booking.findFirst({
          where: {
            id: booking.id,
            status: BookingStatus.COMPLETED,
          },
          include: {
            car: { include: { owner: true } },
            user: true,
            chauffeur: true,
            legs: { include: { extensions: true } },
          },
        });
        if (completedBooking) {
          return this.toAirportCompletionResponse(completedBooking);
        }
        throw new BookingNotFoundException();
      }

      return this.toAirportCompletionResponse(updatedBooking);
    });
  }

  private async completeBookingTransaction(
    tx: Prisma.TransactionClient,
    booking: {
      id: string;
      status: BookingStatus;
      type: BookingType;
      paymentStatus: PaymentStatus;
      carId: string;
      chauffeurId: string | null;
      endDate: Date;
    },
    input: {
      source: BookingCompletionSource;
      completedByUserId: string | null;
      completionTokenHash?: string;
    },
  ): Promise<BookingWithRelations | null> {
    const oldStatus = booking.status;
    const completedAt = new Date();
    const updated = await tx.booking.updateMany({
      where: {
        id: booking.id,
        status: BookingStatus.ACTIVE,
        paymentStatus: PaymentStatus.PAID,
        ...(booking.type === BookingType.AIRPORT_PICKUP
          ? {
              type: BookingType.AIRPORT_PICKUP,
              ...(input.completionTokenHash
                ? {
                    completionTokenHash: input.completionTokenHash,
                    completionTokenExpiresAt: { gt: completedAt },
                  }
                : {}),
            }
          : { type: { not: BookingType.AIRPORT_PICKUP } }),
      },
      data: {
        status: BookingStatus.COMPLETED,
        completedAt,
        completedByUserId: input.completedByUserId,
        completionSource: input.source,
      },
    });
    if (updated.count === 0) {
      return null;
    }
    const updatedBooking = await tx.booking.findUniqueOrThrow({
      where: { id: booking.id },
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
    await this.domainOutboxService.createMany(
      [
        {
          eventType: DomainOutboxEventType.REFERRAL_COMPLETION,
          aggregateId: booking.id,
        },
        {
          eventType: DomainOutboxEventType.PAYOUT_PROCESSING,
          aggregateId: booking.id,
        },
      ],
      tx,
    );
    return updatedBooking;
  }

  private async queueStatusNotification(
    bookingId: string,
    booking: BookingWithRelations,
    oldStatus: string,
    newStatus: string,
    showReviewRequest = false,
    tx?: NotificationOutboxTransactionClient,
    includeChauffeurCompletionLink = false,
  ): Promise<void> {
    try {
      await this.notificationOutboxService.create(
        this.bookingStatusChangedHandler,
        { booking, oldStatus, newStatus, showReviewRequest, includeChauffeurCompletionLink },
        tx,
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error({ bookingId, error: errorMessage }, "Failed to queue status notification");
      // Continue without failing booking status updates
    }
  }

  private toAirportCompletionResponse(booking: {
    id: string;
    bookingReference: string;
    status: BookingStatus;
    pickupLocation: string;
    returnLocation: string;
    completedAt: Date | null;
    car: { make: string; model: string; year: number };
  }) {
    return {
      id: booking.id,
      bookingReference: booking.bookingReference,
      status: booking.status,
      pickupLocation: booking.pickupLocation,
      returnLocation: booking.returnLocation,
      completedAt: booking.completedAt,
      car: {
        make: booking.car.make,
        model: booking.car.model,
        year: booking.car.year,
      },
    };
  }
}
