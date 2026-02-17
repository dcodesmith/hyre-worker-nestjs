import { HttpStatus } from "@nestjs/common";
import { AppException } from "../../common/errors/app.exception";
import type { FieldError } from "../../common/errors/problem-details.interface";

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
 */
export class BookingException extends AppException {}

/**
 * Exception for validation errors during booking creation.
 */
export class BookingValidationException extends BookingException {
  constructor(errors: FieldError[], detail?: string) {
    super(
      BookingErrorCode.VALIDATION_ERROR,
      detail ?? "One or more validation errors occurred",
      HttpStatus.BAD_REQUEST,
      {
        type: BookingErrorCode.VALIDATION_ERROR,
        title: "Validation Failed",
        errors,
      },
    );
  }
}

/**
 * Exception when a car is not available for booking.
 */
export class CarNotAvailableException extends BookingException {
  constructor(carId: string, reason?: string) {
    super(
      BookingErrorCode.CAR_NOT_AVAILABLE,
      reason ?? `Car ${carId} is not available for the selected dates`,
      HttpStatus.CONFLICT,
      {
        type: BookingErrorCode.CAR_NOT_AVAILABLE,
        title: "Car Not Available",
      },
    );
  }
}

/**
 * Exception when a car is not found.
 */
export class CarNotFoundException extends BookingException {
  constructor(carId: string) {
    super(
      BookingErrorCode.CAR_NOT_FOUND,
      `Car with ID ${carId} was not found`,
      HttpStatus.NOT_FOUND,
      {
        type: BookingErrorCode.CAR_NOT_FOUND,
        title: "Car Not Found",
      },
    );
  }
}

/**
 * Exception when payment intent creation fails.
 */
export class PaymentIntentFailedException extends BookingException {
  constructor(detail?: string) {
    super(
      BookingErrorCode.PAYMENT_INTENT_FAILED,
      detail ?? "Failed to create payment intent. Please try again.",
      HttpStatus.BAD_GATEWAY,
      {
        type: BookingErrorCode.PAYMENT_INTENT_FAILED,
        title: "Payment Intent Failed",
      },
    );
  }
}

/**
 * Exception for general booking creation failures.
 */
export class BookingCreationFailedException extends BookingException {
  constructor(detail?: string) {
    super(
      BookingErrorCode.BOOKING_CREATION_FAILED,
      detail ?? "An unexpected error occurred while creating the booking",
      HttpStatus.INTERNAL_SERVER_ERROR,
      {
        type: BookingErrorCode.BOOKING_CREATION_FAILED,
        title: "Booking Creation Failed",
      },
    );
  }
}

/**
 * Exception when a referral discount is no longer available.
 * This occurs when concurrent booking requests race to use the same one-time discount.
 */
export class ReferralDiscountNoLongerAvailableException extends BookingException {
  constructor() {
    super(
      BookingErrorCode.REFERRAL_DISCOUNT_NO_LONGER_AVAILABLE,
      "The referral discount is no longer available. It may have been used in another booking. Please retry without the discount.",
      HttpStatus.CONFLICT,
      {
        type: BookingErrorCode.REFERRAL_DISCOUNT_NO_LONGER_AVAILABLE,
        title: "Referral Discount No Longer Available",
      },
    );
  }
}
