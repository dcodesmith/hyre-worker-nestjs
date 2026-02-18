import { HttpStatus } from "@nestjs/common";
import { AppException } from "../../common/errors/app.exception";

/**
 * Error codes for FlightAware-related errors.
 * These are machine-readable codes that can be used by clients.
 */
export const FlightAwareErrorCode = {
  FLIGHT_NOT_FOUND: "FLIGHT_NOT_FOUND",
  FLIGHT_ALREADY_LANDED: "FLIGHT_ALREADY_LANDED",
  INVALID_FLIGHT_NUMBER: "INVALID_FLIGHT_NUMBER",
  API_ERROR: "FLIGHTAWARE_API_ERROR",
  FLIGHT_RECORD_NOT_FOUND: "FLIGHT_RECORD_NOT_FOUND",
} as const;

/**
 * Base exception for FlightAware-related errors.
 */
export class FlightAwareException extends AppException {
  constructor(errorCode: string, detail: string, status: HttpStatus, title: string) {
    super(errorCode, detail, status, {
      type: errorCode,
      title,
    });
  }
}

/**
 * Exception when a flight is not found.
 */
export class FlightNotFoundException extends FlightAwareException {
  constructor(flightNumber: string, date: string) {
    super(
      FlightAwareErrorCode.FLIGHT_NOT_FOUND,
      `Flight ${flightNumber} not found for ${date}. Please verify the flight number and date.`,
      HttpStatus.NOT_FOUND,
      "Flight Not Found",
    );
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

    super(
      FlightAwareErrorCode.FLIGHT_ALREADY_LANDED,
      detail,
      HttpStatus.CONFLICT,
      "Flight Already Landed",
    );
  }
}

/**
 * Exception for invalid flight number format.
 */
export class InvalidFlightNumberException extends FlightAwareException {
  constructor(flightNumber: string) {
    super(
      FlightAwareErrorCode.INVALID_FLIGHT_NUMBER,
      `Invalid flight number format: ${flightNumber}. Expected format: 2-3 alphanumeric airline code + 1-5 digits (e.g., BA74, AA123)`,
      HttpStatus.BAD_REQUEST,
      "Invalid Flight Number",
    );
  }
}

/**
 * Exception for FlightAware API errors.
 */
export class FlightAwareApiException extends FlightAwareException {
  constructor(message: string) {
    super(FlightAwareErrorCode.API_ERROR, message, HttpStatus.BAD_GATEWAY, "FlightAware API Error");
  }
}

export class FlightRecordNotFoundException extends FlightAwareException {
  constructor(flightId: string) {
    super(
      FlightAwareErrorCode.FLIGHT_RECORD_NOT_FOUND,
      `Flight with id ${flightId} was not found in the database.`,
      HttpStatus.NOT_FOUND,
      "Flight Record Not Found",
    );
  }
}
