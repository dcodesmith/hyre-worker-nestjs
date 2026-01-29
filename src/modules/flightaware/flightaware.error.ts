import { HttpException, HttpStatus } from "@nestjs/common";
import type { ProblemDetails } from "src/common/errors/problem-details.interface";

/**
 * Error codes for FlightAware-related errors.
 * These are machine-readable codes that can be used by clients.
 */
export const FlightAwareErrorCode = {
  FLIGHT_NOT_FOUND: "FLIGHT_NOT_FOUND",
  FLIGHT_ALREADY_LANDED: "FLIGHT_ALREADY_LANDED",
  INVALID_FLIGHT_NUMBER: "INVALID_FLIGHT_NUMBER",
  API_ERROR: "FLIGHTAWARE_API_ERROR",
} as const;

export type FlightAwareErrorCodeType =
  (typeof FlightAwareErrorCode)[keyof typeof FlightAwareErrorCode];

/**
 * Base exception for FlightAware-related errors.
 * Uses RFC 7807 Problem Details format.
 */
export class FlightAwareException extends HttpException {
  constructor(private readonly problemDetails: ProblemDetails) {
    super(problemDetails, problemDetails.status);
  }

  /**
   * Get the problem details for this error.
   */
  getProblemDetails(): ProblemDetails {
    return this.problemDetails;
  }
}

/**
 * Exception when a flight is not found.
 */
export class FlightNotFoundException extends FlightAwareException {
  constructor(flightNumber: string, date: string) {
    super({
      type: FlightAwareErrorCode.FLIGHT_NOT_FOUND,
      title: "Flight Not Found",
      status: HttpStatus.BAD_REQUEST,
      detail: `Flight ${flightNumber} not found for ${date}. Please verify the flight number and date.`,
    });
  }
}

/**
 * Exception when a flight has already landed.
 */
export class FlightAlreadyLandedException extends FlightAwareException {
  constructor(flightNumber: string, landedTime: string, nextFlightDate?: string) {
    const detail = nextFlightDate
      ? `Flight ${flightNumber} has already landed at ${landedTime}. The next flight is on ${nextFlightDate}.`
      : `Flight ${flightNumber} has already landed at ${landedTime}.`;

    super({
      type: FlightAwareErrorCode.FLIGHT_ALREADY_LANDED,
      title: "Flight Already Landed",
      status: HttpStatus.BAD_REQUEST,
      detail,
    });
  }
}

/**
 * Exception for invalid flight number format.
 */
export class InvalidFlightNumberException extends FlightAwareException {
  constructor(flightNumber: string) {
    super({
      type: FlightAwareErrorCode.INVALID_FLIGHT_NUMBER,
      title: "Invalid Flight Number",
      status: HttpStatus.BAD_REQUEST,
      detail: `Invalid flight number format: ${flightNumber}. Expected format: 2-3 alphanumeric airline code + 1-5 digits (e.g., BA74, AA123)`,
    });
  }
}

/**
 * Exception for FlightAware API errors.
 */
export class FlightAwareApiException extends FlightAwareException {
  constructor(message: string) {
    super({
      type: FlightAwareErrorCode.API_ERROR,
      title: "Flight Validation Error",
      status: HttpStatus.BAD_GATEWAY,
      detail: message,
    });
  }
}
