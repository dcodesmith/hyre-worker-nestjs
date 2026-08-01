import { Injectable } from "@nestjs/common";
import {
  BookingStatus,
  type BookingType,
  ChauffeurApprovalStatus,
  PaymentStatus,
  type Prisma,
} from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { DatabaseService } from "../database/database.service";
import { BookingUpdatedHandler } from "../notification/handlers/booking-updated.handler";
import { ChauffeurAssignedHandler } from "../notification/handlers/chauffeur-assigned.handler";
import { NotificationOutboxService } from "../notification/notification-outbox.service";
import { DAY_BOOKING_DURATION_HOURS, FULL_DAY_DURATION_HOURS } from "./booking.const";
import {
  BookingChauffeurNotFoundException,
  BookingException,
  BookingNotFoundException,
  BookingStatusNotModifiableException,
  BookingUpdateFailedException,
  BookingUpdateNotAllowedException,
  BookingValidationException,
} from "./booking.error";
import type { CurrentBookingRecord } from "./booking.interface";
import type { BookingModificationPolicyInput } from "./booking-modification-policy.interface";
import { BookingModificationPolicyService } from "./booking-modification-policy.service";
import { BookingValidationService } from "./booking-validation.service";
import type { UpdateBookingBodyDto } from "./dto/update-booking.dto";

@Injectable()
export class BookingUpdateService {
  private readonly bookingDetailsInclude = {
    car: { include: { owner: true } },
    user: true,
    chauffeur: true,
    flight: true,
    review: {
      include: {
        user: {
          select: {
            id: true,
            name: true,
            image: true,
          },
        },
      },
    },
    legs: {
      orderBy: { legDate: "asc" },
      include: {
        extensions: {
          where: { status: "ACTIVE", paymentStatus: PaymentStatus.PAID },
        },
      },
    },
  } as const;

  constructor(
    private readonly bookingValidationService: BookingValidationService,
    private readonly bookingModificationPolicyService: BookingModificationPolicyService,
    private readonly databaseService: DatabaseService,
    private readonly notificationOutboxService: NotificationOutboxService,
    private readonly chauffeurAssignedHandler: ChauffeurAssignedHandler,
    private readonly bookingUpdatedHandler: BookingUpdatedHandler,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(BookingUpdateService.name);
  }

  async updateBooking(bookingId: string, userId: string, input: UpdateBookingBodyDto) {
    try {
      return await this.updateBookingInternal(bookingId, userId, input);
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
        "Failed to update booking",
      );
      throw new BookingUpdateFailedException();
    }
  }

  async assignChauffeur(bookingId: string, ownerId: string, chauffeurId: string) {
    try {
      const booking = await this.databaseService.$transaction(async (tx) => {
        const booking = await tx.booking.findFirst({
          where: {
            id: bookingId,
            deletedAt: null,
            car: { ownerId },
          },
          select: {
            id: true,
            chauffeurId: true,
            flightId: true,
            status: true,
          },
        });

        if (!booking) {
          throw new BookingNotFoundException();
        }

        if (booking.status !== BookingStatus.CONFIRMED) {
          throw new BookingUpdateNotAllowedException(
            "Only confirmed bookings can be assigned a chauffeur",
          );
        }

        const chauffeur = await tx.user.findFirst({
          where: {
            id: chauffeurId,
            fleetOwnerId: ownerId,
          },
          select: {
            id: true,
            chauffeurApprovalStatus: true,
          },
        });

        if (!chauffeur) {
          throw new BookingChauffeurNotFoundException();
        }

        if (chauffeur.chauffeurApprovalStatus !== ChauffeurApprovalStatus.APPROVED) {
          throw new BookingUpdateNotAllowedException(
            "Only approved chauffeurs can be assigned to a booking",
          );
        }

        const updated = await tx.booking.updateMany({
          where: {
            id: booking.id,
            deletedAt: null,
            status: BookingStatus.CONFIRMED,
            chauffeurId: booking.chauffeurId,
            car: { ownerId },
          },
          data: { chauffeurId: chauffeur.id },
        });

        if (updated.count === 0) {
          throw new BookingUpdateNotAllowedException(
            "Booking changed during assignment. Please retry",
          );
        }

        if (booking.flightId) {
          await tx.$executeRaw`SELECT 1 FROM "Flight" WHERE "id" = ${booking.flightId} FOR UPDATE`;
        }

        const updatedBooking = await tx.booking.findUniqueOrThrow({
          where: { id: booking.id },
          include: this.bookingDetailsInclude,
        });
        if (booking.chauffeurId !== chauffeur.id) {
          await this.notificationOutboxService.create(
            this.chauffeurAssignedHandler,
            { booking: updatedBooking, chauffeurId: chauffeur.id },
            tx,
          );
        }

        return updatedBooking;
      });

      return booking;
    } catch (error) {
      if (error instanceof BookingException) {
        throw error;
      }

      this.logger.error(
        {
          bookingId,
          ownerId,
          chauffeurId,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        "Failed to assign chauffeur to booking",
      );
      throw new BookingUpdateFailedException();
    }
  }

  private async updateBookingInternal(
    bookingId: string,
    userId: string,
    input: UpdateBookingBodyDto,
  ) {
    const currentBooking = await this.getCurrentBookingForUser(bookingId, userId);
    this.bookingModificationPolicyService.assertCanEdit(currentBooking);

    const { newStartDate, newEndDate } = this.resolveUpdatedDates(currentBooking, input.pickupTime);
    if (newStartDate) {
      this.bookingModificationPolicyService.assertWithinWindow(newStartDate);
    }

    const { newPickupLocation, newReturnLocation } = this.resolveLocationUpdates(
      currentBooking,
      input,
    );
    await this.validateUpdatedDatesAndAvailability(currentBooking, newStartDate, newEndDate);

    const updateData = {
      ...(newStartDate ? { startDate: newStartDate } : {}),
      ...(newEndDate ? { endDate: newEndDate } : {}),
      ...(newPickupLocation ? { pickupLocation: newPickupLocation } : {}),
      ...(newReturnLocation ? { returnLocation: newReturnLocation } : {}),
    };

    if (Object.keys(updateData).length === 0) {
      const booking = await this.getBookingDetailsById(currentBooking.id);
      return booking ? this.withModificationEligibility(booking) : booking;
    }

    return this.databaseService.$transaction(async (tx) => {
      const bookingLocked = await this.lockEditableBookingState(
        tx,
        bookingId,
        userId,
        currentBooking.startDate,
      );
      if (!bookingLocked) {
        throw new BookingStatusNotModifiableException(
          "edit",
          "Booking state changed during the update. Please retry",
        );
      }

      const policyNow = await this.getDatabaseNow(tx);
      this.bookingModificationPolicyService.assertCanEdit(currentBooking, policyNow);
      if (newStartDate) {
        this.bookingModificationPolicyService.assertWithinWindow(newStartDate, policyNow);
      }

      const startDateThreshold =
        this.bookingModificationPolicyService.getStartDateThreshold(policyNow);
      const updated = await tx.booking.updateMany({
        where: {
          id: bookingId,
          userId,
          status: BookingStatus.CONFIRMED,
          startDate: {
            equals: currentBooking.startDate,
            gt: startDateThreshold,
          },
        },
        data: updateData,
      });
      if (updated.count === 0) {
        throw new BookingStatusNotModifiableException(
          "edit",
          "Booking state changed during the update. Please retry",
        );
      }

      const updatedBooking = await tx.booking.findUniqueOrThrow({
        where: { id: bookingId },
        include: this.bookingDetailsInclude,
      });
      await this.notificationOutboxService.create(
        this.bookingUpdatedHandler,
        {
          booking: updatedBooking,
          actor: { type: "user", userId },
        },
        tx,
      );
      return this.withModificationEligibility(updatedBooking);
    });
  }

  private async lockEditableBookingState(
    tx: Prisma.TransactionClient,
    bookingId: string,
    userId: string,
    currentStartDate: Date,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT booking."id"
      FROM "Booking" AS booking
      WHERE booking."id" = ${bookingId}
        AND booking."userId" = ${userId}
        AND booking."status" = ${BookingStatus.CONFIRMED}::"BookingStatus"
        AND booking."startDate" = ${currentStartDate}
      FOR UPDATE OF booking
    `;

    return rows.length > 0;
  }

  private async getDatabaseNow(tx: Prisma.TransactionClient): Promise<Date> {
    const [clock] = await tx.$queryRaw<Array<{ policyNow: Date }>>`
      SELECT clock_timestamp() AS "policyNow"
    `;
    return clock.policyNow;
  }

  private getBookingDetailsById(bookingId: string) {
    return this.databaseService.booking.findUnique({
      where: { id: bookingId },
      include: this.bookingDetailsInclude,
    });
  }

  private resolveLocationUpdates(
    currentBooking: CurrentBookingRecord,
    input: UpdateBookingBodyDto,
  ) {
    const newPickupLocation =
      input.pickupAddress && input.pickupAddress !== currentBooking.pickupLocation
        ? input.pickupAddress
        : undefined;
    const effectivePickupLocation = newPickupLocation ?? currentBooking.pickupLocation;

    const targetReturnLocation = this.resolveTargetReturnLocation(
      input,
      effectivePickupLocation,
      currentBooking.returnLocation,
    );
    const newReturnLocation =
      targetReturnLocation && targetReturnLocation !== currentBooking.returnLocation
        ? targetReturnLocation
        : undefined;

    return { newPickupLocation, newReturnLocation };
  }

  private async getCurrentBookingForUser(
    bookingId: string,
    userId: string,
  ): Promise<CurrentBookingRecord> {
    const currentBooking = await this.databaseService.booking.findFirst({
      where: { id: bookingId, userId },
      select: {
        id: true,
        userId: true,
        carId: true,
        type: true,
        status: true,
        paymentStatus: true,
        startDate: true,
        endDate: true,
        pickupLocation: true,
        returnLocation: true,
      },
    });

    if (!currentBooking) {
      throw new BookingNotFoundException();
    }

    return currentBooking;
  }

  private resolveTargetReturnLocation(
    input: UpdateBookingBodyDto,
    effectivePickupLocation: string,
    currentReturnLocation: string,
  ): string | undefined {
    if (input.sameLocation === true) {
      return effectivePickupLocation;
    }
    if (input.sameLocation === false) {
      return input.dropOffAddress;
    }
    return input.dropOffAddress ?? currentReturnLocation;
  }

  private async validateUpdatedDatesAndAvailability(
    currentBooking: CurrentBookingRecord,
    newStartDate?: Date,
    newEndDate?: Date,
  ): Promise<void> {
    if (!newStartDate || !newEndDate) {
      return;
    }

    this.bookingValidationService.validateDates({
      startDate: newStartDate,
      endDate: newEndDate,
      bookingType: currentBooking.type,
    });

    await this.bookingValidationService.checkCarAvailability({
      carId: currentBooking.carId,
      startDate: newStartDate,
      endDate: newEndDate,
      excludeBookingId: currentBooking.id,
    });
  }

  private resolveUpdatedDates(
    currentBooking: { type: BookingType; startDate: Date },
    pickupTime?: string,
  ): { newStartDate?: Date; newEndDate?: Date } {
    if (!pickupTime) {
      return {};
    }

    if (currentBooking.type !== "DAY" && currentBooking.type !== "FULL_DAY") {
      throw new BookingValidationException([
        {
          field: "pickupTime",
          message: "Pickup time can only be updated for DAY or FULL_DAY bookings",
        },
      ]);
    }

    const match = /^(1[0-2]|[1-9])(?::([0-5]\d))?\s?(AM|PM)$/i.exec(pickupTime.trim());
    if (!match) {
      throw new BookingValidationException([
        {
          field: "pickupTime",
          message: "Invalid pickup time format. Expected H:MM AM/PM",
        },
      ]);
    }

    let hour = Number.parseInt(match[1], 10);
    const minute = match[2] ? Number.parseInt(match[2], 10) : 0;
    const period = match[3].toUpperCase();

    if (period === "PM" && hour !== 12) {
      hour += 12;
    } else if (period === "AM" && hour === 12) {
      hour = 0;
    }

    const newStartDate = new Date(currentBooking.startDate);
    newStartDate.setHours(hour, minute, 0, 0);

    const newEndDate = new Date(newStartDate);
    const durationHours =
      currentBooking.type === "FULL_DAY" ? FULL_DAY_DURATION_HOURS : DAY_BOOKING_DURATION_HOURS;
    newEndDate.setHours(newEndDate.getHours() + durationHours);

    return { newStartDate, newEndDate };
  }

  private withModificationEligibility<T extends BookingModificationPolicyInput>(booking: T) {
    return {
      ...booking,
      ...this.bookingModificationPolicyService.getEligibility(booking),
    };
  }
}
