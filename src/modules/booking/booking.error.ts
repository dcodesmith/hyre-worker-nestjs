import { HttpException, HttpStatus } from "@nestjs/common";
import type {
  FieldError,
  ProblemDetails,
  ValidationProblemDetails,
} from "src/common/errors/problem-details.interface";

/**
 * Error codes for booking-related errors.
 * These are machine-readable codes that can be used by clients.
 */
export const BookingErrorCode = {
  // Validation errors
  VALIDATION_ERROR: "VALIDATION_ERROR",
  INVALID_DATES: "INVALID_DATES",
  PAST_BOOKING: "PAST_BOOKING",
  SAME_DAY_CUTOFF: "SAME_DAY_CUTOFF",
  AIRPORT_ADVANCE_NOTICE: "AIRPORT_ADVANCE_NOTICE",
  MISSING_PICKUP_TIME: "MISSING_PICKUP_TIME",
  MISSING_FLIGHT_NUMBER: "MISSING_FLIGHT_NUMBER",
  PRICE_MISMATCH: "PRICE_MISMATCH",

  // Car availability errors
  CAR_NOT_FOUND: "CAR_NOT_FOUND",
  CAR_NOT_AVAILABLE: "CAR_NOT_AVAILABLE",
  CAR_NOT_APPROVED: "CAR_NOT_APPROVED",

  // Flight errors
  FLIGHT_NOT_FOUND: "FLIGHT_NOT_FOUND",
  FLIGHT_ALREADY_LANDED: "FLIGHT_ALREADY_LANDED",
  FLIGHT_VALIDATION_ERROR: "FLIGHT_VALIDATION_ERROR",

  // User/guest errors
  GUEST_EMAIL_REGISTERED: "GUEST_EMAIL_REGISTERED",
  USER_NOT_FOUND: "USER_NOT_FOUND",

  // Payment errors
  PAYMENT_INTENT_FAILED: "PAYMENT_INTENT_FAILED",

  // General errors
  BOOKING_CREATION_FAILED: "BOOKING_CREATION_FAILED",
} as const;

export type BookingErrorCodeType = (typeof BookingErrorCode)[keyof typeof BookingErrorCode];

/**
 * Base exception for booking-related errors.
 * Uses RFC 7807 Problem Details format.
 */
export class BookingException extends HttpException {
  constructor(private readonly problemDetails: ProblemDetails | ValidationProblemDetails) {
    super(problemDetails, problemDetails.status);
  }

  /**
   * Get the problem details for this error.
   */
  getProblemDetails(): ProblemDetails | ValidationProblemDetails {
    return this.problemDetails;
  }
}

/**
 * Exception for validation errors during booking creation.
 */
export class BookingValidationException extends BookingException {
  constructor(errors: FieldError[], detail?: string) {
    super({
      type: BookingErrorCode.VALIDATION_ERROR,
      title: "Validation Failed",
      status: HttpStatus.BAD_REQUEST,
      detail: detail ?? "One or more validation errors occurred",
      errors,
    });
  }
}

/**
 * Exception when a car is not available for booking.
 */
export class CarNotAvailableException extends BookingException {
  constructor(carId: string, reason?: string) {
    super({
      type: BookingErrorCode.CAR_NOT_AVAILABLE,
      title: "Car Not Available",
      status: HttpStatus.CONFLICT,
      detail: reason ?? `Car ${carId} is not available for the selected dates`,
    });
  }
}

/**
 * Exception when a car is not found.
 */
export class CarNotFoundException extends BookingException {
  constructor(carId: string) {
    super({
      type: BookingErrorCode.CAR_NOT_FOUND,
      title: "Car Not Found",
      status: HttpStatus.NOT_FOUND,
      detail: `Car with ID ${carId} was not found`,
    });
  }
}

const FLIGHT_ERROR_TITLES: Record<
  | typeof BookingErrorCode.FLIGHT_NOT_FOUND
  | typeof BookingErrorCode.FLIGHT_ALREADY_LANDED
  | typeof BookingErrorCode.FLIGHT_VALIDATION_ERROR,
  string
> = {
  [BookingErrorCode.FLIGHT_NOT_FOUND]: "Flight Not Found",
  [BookingErrorCode.FLIGHT_ALREADY_LANDED]: "Flight Already Landed",
  [BookingErrorCode.FLIGHT_VALIDATION_ERROR]: "Flight Validation Error",
};

/**
 * Exception for flight validation errors.
 */
export class FlightValidationException extends BookingException {
  constructor(
    code:
      | typeof BookingErrorCode.FLIGHT_NOT_FOUND
      | typeof BookingErrorCode.FLIGHT_ALREADY_LANDED
      | typeof BookingErrorCode.FLIGHT_VALIDATION_ERROR,
    detail: string,
  ) {
    super({
      type: code,
      title: FLIGHT_ERROR_TITLES[code],
      status: HttpStatus.BAD_REQUEST,
      detail,
    });
  }
}

/**
 * Exception when payment intent creation fails.
 */
export class PaymentIntentFailedException extends BookingException {
  constructor(detail?: string) {
    super({
      type: BookingErrorCode.PAYMENT_INTENT_FAILED,
      title: "Payment Intent Failed",
      status: HttpStatus.BAD_GATEWAY,
      detail: detail ?? "Failed to create payment intent. Please try again.",
    });
  }
}

/**
 * Exception for general booking creation failures.
 */
export class BookingCreationFailedException extends BookingException {
  constructor(detail?: string) {
    super({
      type: BookingErrorCode.BOOKING_CREATION_FAILED,
      title: "Booking Creation Failed",
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      detail: detail ?? "An unexpected error occurred while creating the booking",
    });
  }
}
