import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { BookingStatus, CarApprovalStatus, PaymentStatus, Status } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { DatabaseService } from "../database/database.service";
import {
  AIRPORT_PICKUP_MIN_ADVANCE_MS,
  BOOKING_BUFFER_HOURS,
  PRICE_TOLERANCE,
  SAME_DAY_BOOKING_CUTOFF_HOUR,
} from "./booking.const";
import {
  CarAvailabilityInput,
  DateValidationInput,
  ValidationError,
  ValidationResult,
} from "./booking.interface";
import type { CreateBookingInput } from "./dto/create-booking.dto";
import { isGuestBooking } from "./dto/create-booking.dto";
import { maskEmail } from "src/shared/helper";

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
   * @returns Validation result with any errors
   */
  validateDates(input: DateValidationInput): ValidationResult {
    const errors: ValidationError[] = [];
    const now = new Date();

    const { startDate, endDate, bookingType } = input;

    // Rule: End date must be >= start date
    if (endDate < startDate) {
      errors.push({
        field: "endDate",
        message: "End date must be on or after start date",
      });
    }

    // Rule: Airport pickup requires minimum 1-hour advance notice
    if (bookingType === "AIRPORT_PICKUP") {
      const oneHourFromNow = new Date(now.getTime() + AIRPORT_PICKUP_MIN_ADVANCE_MS);
      if (startDate < oneHourFromNow) {
        errors.push({
          field: "startDate",
          message: "Booking start time cannot be in the past",
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

    return {
      valid: errors.length === 0,
      errors,
    };
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
   * @returns Validation result with any conflicts
   */
  async checkCarAvailability(input: CarAvailabilityInput): Promise<ValidationResult> {
    const errors: ValidationError[] = [];
    const { carId, startDate, endDate, excludeBookingId } = input;

    // Verify car exists and is bookable
    const car = await this.databaseService.car.findUnique({
      where: { id: carId },
      select: { id: true, status: true, approvalStatus: true },
    });

    if (!car) {
      errors.push({
        field: "carId",
        message: "Car not found",
      });
      return { valid: false, errors };
    }

    // Check car approval status - only approved cars can be booked
    if (car.approvalStatus !== CarApprovalStatus.APPROVED) {
      this.logger.log("Attempt to book unapproved car", {
        carId,
        approvalStatus: car.approvalStatus,
      });

      errors.push({
        field: "carId",
        message: "This vehicle is not available for booking",
      });
      return { valid: false, errors };
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

      errors.push({
        field: "carId",
        message: statusMessages[car.status] || "This vehicle is not available for booking",
      });
      return { valid: false, errors };
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

      errors.push({
        field: "carId",
        message:
          "Car is not available for the selected dates. Please choose different dates or another vehicle.",
      });
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate that a guest email is not already registered as a user.
   *
   * This prevents guest bookings from users who should log in instead.
   *
   * @param input - Booking input (guest or authenticated)
   * @returns Validation result
   */
  async validateGuestEmail(input: CreateBookingInput): Promise<ValidationResult> {
    const errors: ValidationError[] = [];

    // Only validate if this is a guest booking
    if (!isGuestBooking(input)) {
      return { valid: true, errors: [] };
    }

    const existingUser = await this.databaseService.user.findUnique({
      where: { email: input.guestEmail },
      select: { id: true },
    });

    if (existingUser) {
      this.logger.log("Guest email already registered", {
        email: maskEmail(input.guestEmail),
      });

      errors.push({
        field: "guestEmail",
        message: "This email is already registered. Please log in to make a booking.",
      });
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate that client-provided total matches server calculation.
   *
   * This prevents price manipulation attacks where the client sends
   * a lower amount than the actual calculated price.
   *
   * @param clientTotal - Total amount sent by client (as string)
   * @param serverTotal - Total amount calculated by server
   * @returns Validation result
   */
  validatePriceMatch(clientTotal: string | undefined, serverTotal: Decimal): ValidationResult {
    const errors: ValidationError[] = [];

    // Skip validation if client didn't provide a total
    if (!clientTotal) {
      return { valid: true, errors: [] };
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

        errors.push({
          field: "clientTotalAmount",
          message: "Price mismatch. Please refresh and try again.",
        });
      }
    } catch {
      errors.push({
        field: "clientTotalAmount",
        message: "Invalid price format",
      });
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Run all validations and throw if any fail.
   *
   * @param input - Booking input
   * @param serverTotal - Server-calculated total (optional)
   * @throws BadRequestException if validation fails
   */
  async validateAll(input: CreateBookingInput, serverTotal?: Decimal): Promise<void> {
    const allErrors: ValidationError[] = [];

    // Date validation
    const dateResult = this.validateDates({
      startDate: input.startDate,
      endDate: input.endDate,
      bookingType: input.bookingType,
    });
    allErrors.push(...dateResult.errors);

    // Car availability
    const availabilityResult = await this.checkCarAvailability({
      carId: input.carId,
      startDate: input.startDate,
      endDate: input.endDate,
    });
    allErrors.push(...availabilityResult.errors);

    // Guest email validation
    const guestResult = await this.validateGuestEmail(input);
    allErrors.push(...guestResult.errors);

    // Price validation (if server total provided)
    if (serverTotal) {
      const priceResult = this.validatePriceMatch(input.clientTotalAmount, serverTotal);
      allErrors.push(...priceResult.errors);
    }

    if (allErrors.length > 0) {
      throw new BadRequestException({
        message: "Validation failed",
        errors: allErrors,
      });
    }
  }
}
