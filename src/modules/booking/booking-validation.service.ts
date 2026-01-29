import { Injectable, Logger } from "@nestjs/common";
import { BookingStatus, CarApprovalStatus, PaymentStatus, Status } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import type { FieldError } from "src/common/errors/problem-details.interface";
import { maskEmail } from "src/shared/helper";
import { DatabaseService } from "../database/database.service";
import {
  AIRPORT_PICKUP_MIN_ADVANCE_MS,
  BOOKING_BUFFER_HOURS,
  PRICE_TOLERANCE,
  SAME_DAY_BOOKING_CUTOFF_HOUR,
} from "./booking.const";
import {
  BookingValidationException,
  CarNotAvailableException,
  CarNotFoundException,
} from "./booking.error";
import type { CarAvailabilityInput, DateValidationInput } from "./booking.interface";
import type { CreateBookingInput } from "./dto/create-booking.dto";
import { isGuestBooking } from "./dto/create-booking.dto";

/**
 * Service for validating booking creation requests.
 *
 * This service handles:
 * - Date/time validation (past bookings, same-day rules, airport lead time)
 * - Car availability checking with buffer zones
 * - Guest email validation (prevent duplicate accounts)
 * - Price validation (client vs server calculation)
 */
@Injectable()
export class BookingValidationService {
  private readonly logger = new Logger(BookingValidationService.name);

  constructor(private readonly databaseService: DatabaseService) {}

  /**
   * Validate booking dates and times based on business rules.
   *
   * Rules:
   * - End date must be >= start date (already validated in DTO)
   * - Cannot book in the past
   * - Airport pickup: minimum 1-hour advance notice
   * - Same-day DAY bookings: not allowed after 11 AM
   *
   * @param input - Date validation input
   * @throws BookingValidationException if any date rules are violated
   */
  validateDates(input: DateValidationInput): void {
    const errors: FieldError[] = [];
    const now = new Date();

    const { startDate, endDate, bookingType } = input;

    // Rule: End date must be > start date (zero-duration bookings not allowed)
    if (endDate <= startDate) {
      errors.push({
        field: "endDate",
        message: "End date must be after start date",
      });
    }

    // Rule: Airport pickup requires minimum 1-hour advance notice
    if (bookingType === "AIRPORT_PICKUP") {
      const oneHourFromNow = new Date(now.getTime() + AIRPORT_PICKUP_MIN_ADVANCE_MS);
      if (startDate < oneHourFromNow) {
        errors.push({
          field: "startDate",
          message: "Airport pickup bookings require at least 1 hour advance notice",
        });
      }
    } else {
      // Rule: Cannot book in the past (for non-airport bookings)
      if (startDate < now) {
        errors.push({
          field: "startDate",
          message: "Booking start time cannot be in the past",
        });
      }

      // Rule: Same-day DAY bookings not allowed after 11 AM
      if (bookingType === "DAY") {
        const isSameDay =
          startDate.getFullYear() === now.getFullYear() &&
          startDate.getMonth() === now.getMonth() &&
          startDate.getDate() === now.getDate();

        if (isSameDay && now.getHours() >= SAME_DAY_BOOKING_CUTOFF_HOUR) {
          errors.push({
            field: "startDate",
            message: "Same-day DAY bookings cannot be made at or after 11 AM",
          });
        }
      }
    }

    if (errors.length > 0) {
      throw new BookingValidationException(errors);
    }
  }

  /**
   * Check if a car is available for the requested booking period.
   *
   * A car is unavailable if there are overlapping bookings with:
   * - Status: CONFIRMED or ACTIVE
   * - PaymentStatus: PAID
   *
   * A 2-hour buffer is applied between bookings for car preparation.
   *
   * @param input - Car availability check input
   * @throws CarNotFoundException if car does not exist
   * @throws CarNotAvailableException if car is not approved, not available, or has conflicts
   */
  async checkCarAvailability(input: CarAvailabilityInput): Promise<void> {
    const { carId, startDate, endDate, excludeBookingId } = input;

    // Verify car exists and is bookable
    const car = await this.databaseService.car.findUnique({
      where: { id: carId },
      select: { id: true, status: true, approvalStatus: true },
    });

    if (!car) {
      throw new CarNotFoundException(carId);
    }

    // Check car approval status - only approved cars can be booked
    if (car.approvalStatus !== CarApprovalStatus.APPROVED) {
      this.logger.log("Attempt to book unapproved car", {
        carId,
        approvalStatus: car.approvalStatus,
      });
      throw new CarNotAvailableException(carId, "This vehicle is not available for booking");
    }

    // Check car status - only available cars can be booked
    if (car.status !== Status.AVAILABLE) {
      this.logger.log("Attempt to book unavailable car", {
        carId,
        status: car.status,
      });

      const statusMessages: Record<Status, string> = {
        [Status.AVAILABLE]: "", // Won't be used
        [Status.BOOKED]: "This vehicle is currently booked",
        [Status.HOLD]: "This vehicle is temporarily unavailable",
        [Status.IN_SERVICE]: "This vehicle is currently under maintenance",
      };

      throw new CarNotAvailableException(
        carId,
        statusMessages[car.status] || "This vehicle is not available for booking",
      );
    }

    // Calculate buffered time window
    const bufferedStart = new Date(startDate.getTime() - BOOKING_BUFFER_HOURS * 60 * 60 * 1000);
    const bufferedEnd = new Date(endDate.getTime() + BOOKING_BUFFER_HOURS * 60 * 60 * 1000);

    // Find conflicting bookings
    const conflictingBookings = await this.databaseService.booking.findMany({
      where: {
        carId,
        paymentStatus: PaymentStatus.PAID,
        status: { in: [BookingStatus.CONFIRMED, BookingStatus.ACTIVE] },
        // Exclude current booking if this is an update
        ...(excludeBookingId && { id: { not: excludeBookingId } }),
        // Check for overlap with buffer
        startDate: { lt: bufferedEnd },
        endDate: { gt: bufferedStart },
      },
      select: {
        id: true,
        startDate: true,
        endDate: true,
        bookingReference: true,
      },
    });

    if (conflictingBookings.length > 0) {
      this.logger.log("Car availability conflict found", {
        carId,
        requestedStart: startDate.toISOString(),
        requestedEnd: endDate.toISOString(),
        conflictingBookings: conflictingBookings.map((b) => ({
          id: b.id,
          reference: b.bookingReference,
          start: b.startDate.toISOString(),
          end: b.endDate.toISOString(),
        })),
      });

      throw new CarNotAvailableException(
        carId,
        "Car is not available for the selected dates. Please choose different dates or another vehicle.",
      );
    }
  }

  /**
   * Validate that a guest email is not already registered as a user.
   *
   * This prevents guest bookings from users who should log in instead.
   *
   * @param input - Booking input (guest or authenticated)
   * @throws BookingValidationException if the guest email is already registered
   */
  async validateGuestEmail(input: CreateBookingInput): Promise<void> {
    // Only validate if this is a guest booking
    if (!isGuestBooking(input)) {
      return;
    }

    const existingUser = await this.databaseService.user.findUnique({
      where: { email: input.guestEmail },
      select: { id: true },
    });

    if (existingUser) {
      this.logger.log("Guest email already registered", {
        email: maskEmail(input.guestEmail),
      });

      throw new BookingValidationException([
        {
          field: "guestEmail",
          message: "This email is already registered. Please log in to make a booking.",
        },
      ]);
    }
  }

  /**
   * Validate that client-provided total matches server calculation.
   *
   * This prevents price manipulation attacks where the client sends
   * a lower amount than the actual calculated price.
   *
   * @param clientTotal - Total amount sent by client (as string)
   * @param serverTotal - Total amount calculated by server
   * @throws BookingValidationException if prices don't match
   */
  validatePriceMatch(clientTotal: string | undefined, serverTotal: Decimal): void {
    // Skip validation if client didn't provide a total
    if (!clientTotal) {
      return;
    }

    try {
      const clientDecimal = new Decimal(clientTotal);
      const difference = clientDecimal.minus(serverTotal).abs();

      if (difference.greaterThan(PRICE_TOLERANCE)) {
        this.logger.warn("Price mismatch detected", {
          clientTotal: clientDecimal.toString(),
          serverTotal: serverTotal.toString(),
          difference: difference.toString(),
        });

        throw new BookingValidationException([
          {
            field: "clientTotalAmount",
            message: "Price mismatch. Please refresh and try again.",
          },
        ]);
      }
    } catch (error) {
      // Re-throw if it's already a BookingValidationException
      if (error instanceof BookingValidationException) {
        throw error;
      }
      // Otherwise it's an invalid format
      throw new BookingValidationException([
        {
          field: "clientTotalAmount",
          message: "Invalid price format",
        },
      ]);
    }
  }

  /**
   * Run all validations. Each method throws its own exception on failure.
   *
   * @param input - Booking input
   * @param serverTotal - Server-calculated total (optional)
   * @throws BookingValidationException for validation errors
   * @throws CarNotFoundException if car doesn't exist
   * @throws CarNotAvailableException if car is not available
   */
  async validateAll(input: CreateBookingInput, serverTotal?: Decimal): Promise<void> {
    // Date validation (throws BookingValidationException)
    this.validateDates({
      startDate: input.startDate,
      endDate: input.endDate,
      bookingType: input.bookingType,
    });

    // Car availability (throws CarNotFoundException or CarNotAvailableException)
    await this.checkCarAvailability({
      carId: input.carId,
      startDate: input.startDate,
      endDate: input.endDate,
    });

    // Guest email validation (throws BookingValidationException)
    await this.validateGuestEmail(input);

    // Price validation (throws BookingValidationException)
    if (serverTotal) {
      this.validatePriceMatch(input.clientTotalAmount, serverTotal);
    }
  }
}
