import { HttpException, HttpStatus } from "@nestjs/common";
import type {
  FieldError,
  ProblemDetails,
  ValidationProblemDetails,
} from "src/common/errors/problem-details.interface";

/**
 * Error codes for booking-related errors.
 * These are machine-readable codes that can be used by clients.
 *
 * Note: Flight-related errors are defined in src/modules/flightaware/flightaware.error.ts
 */
export const BookingErrorCode = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  CAR_NOT_FOUND: "CAR_NOT_FOUND",
  CAR_NOT_AVAILABLE: "CAR_NOT_AVAILABLE",
  PAYMENT_INTENT_FAILED: "PAYMENT_INTENT_FAILED",
  BOOKING_CREATION_FAILED: "BOOKING_CREATION_FAILED",
  REFERRAL_DISCOUNT_NO_LONGER_AVAILABLE: "REFERRAL_DISCOUNT_NO_LONGER_AVAILABLE",
} as const;

/**
 * Base exception for booking-related errors.
 * Uses RFC 7807 Problem Details format.
 */
export class BookingException extends HttpException {
  constructor(problemDetails: ProblemDetails | ValidationProblemDetails) {
    super(problemDetails, problemDetails.status);
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

/**
 * Exception when a referral discount is no longer available.
 * This occurs when concurrent booking requests race to use the same one-time discount.
 */
export class ReferralDiscountNoLongerAvailableException extends BookingException {
  constructor() {
    super({
      type: BookingErrorCode.REFERRAL_DISCOUNT_NO_LONGER_AVAILABLE,
      title: "Referral Discount No Longer Available",
      status: HttpStatus.CONFLICT,
      detail:
        "The referral discount is no longer available. It may have been used in another booking. Please retry without the discount.",
    });
  }
}
