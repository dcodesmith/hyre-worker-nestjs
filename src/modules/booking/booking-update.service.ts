import { Injectable, Logger } from "@nestjs/common";
import { BookingStatus, type BookingType, PaymentStatus } from "@prisma/client";
import { DatabaseService } from "../database/database.service";
import { DAY_BOOKING_DURATION_HOURS, FULL_DAY_DURATION_HOURS } from "./booking.const";
import {
  BookingException,
  BookingNotFoundException,
  BookingUpdateFailedException,
  BookingUpdateNotAllowedException,
  BookingValidationException,
} from "./booking.error";
import { BookingValidationService } from "./booking-validation.service";
import type { UpdateBookingBodyDto } from "./dto/update-booking.dto";

type CurrentBookingRecord = {
  id: string;
  userId: string | null;
  carId: string;
  type: BookingType;
  status: BookingStatus;
  startDate: Date;
  endDate: Date;
  pickupLocation: string;
  returnLocation: string;
};

@Injectable()
export class BookingUpdateService {
  private readonly logger = new Logger(BookingUpdateService.name);
  private readonly bookingEditWindowMs = 12 * 60 * 60 * 1000;
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
    private readonly databaseService: DatabaseService,
  ) {}

  async updateBooking(bookingId: string, userId: string, input: UpdateBookingBodyDto) {
    try {
      return await this.updateBookingInternal(bookingId, userId, input);
    } catch (error) {
      if (error instanceof BookingException) {
        throw error;
      }

      this.logger.error("Failed to update booking", {
        bookingId,
        userId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw new BookingUpdateFailedException();
    }
  }

  private async updateBookingInternal(
    bookingId: string,
    userId: string,
    input: UpdateBookingBodyDto,
  ) {
    const currentBooking = await this.getCurrentBookingForUser(bookingId, userId);
    this.assertBookingCanBeUpdated(currentBooking);

    const { newStartDate, newEndDate } = this.resolveUpdatedDates(currentBooking, input.pickupTime);
    this.assertWithinEditWindow(newStartDate ?? currentBooking.startDate);

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
      return this.getBookingDetailsById(currentBooking.id);
    }

    return this.databaseService.booking.update({
      where: { id: bookingId },
      data: updateData,
      include: this.bookingDetailsInclude,
    });
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

  private assertWithinEditWindow(effectiveStartDate: Date): void {
    if (effectiveStartDate.getTime() - Date.now() < this.bookingEditWindowMs) {
      throw new BookingUpdateNotAllowedException(
        "Bookings cannot be edited within 12 hours of start time",
      );
    }
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

  private assertBookingCanBeUpdated(currentBooking: CurrentBookingRecord): void {
    if (currentBooking.status !== BookingStatus.CONFIRMED) {
      throw new BookingUpdateNotAllowedException("Only confirmed bookings can be updated");
    }
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
}
