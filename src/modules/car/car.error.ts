import { HttpStatus } from "@nestjs/common";
import { AppException } from "../../common/errors/app.exception";

export const CarErrorCode = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  FLEET_OWNER_NOT_FOUND: "FLEET_OWNER_NOT_FOUND",
  CAR_NOT_FOUND: "CAR_NOT_FOUND",
  CAR_FETCH_FAILED: "CAR_FETCH_FAILED",
  CAR_CREATE_FAILED: "CAR_CREATE_FAILED",
  CAR_UPDATE_FAILED: "CAR_UPDATE_FAILED",
  OWNER_DRIVER_CAR_LIMIT_REACHED: "OWNER_DRIVER_CAR_LIMIT_REACHED",
  REGISTRATION_NUMBER_ALREADY_EXISTS: "REGISTRATION_NUMBER_ALREADY_EXISTS",
} as const;

export class CarException extends AppException {}

export class CarValidationException extends CarException {
  constructor(detail: string) {
    super(CarErrorCode.VALIDATION_ERROR, detail, HttpStatus.BAD_REQUEST, {
      title: "Validation Failed",
    });
  }
}

export class FleetOwnerNotFoundException extends CarException {
  constructor() {
    super(
      CarErrorCode.FLEET_OWNER_NOT_FOUND,
      "Fleet owner account not found",
      HttpStatus.INTERNAL_SERVER_ERROR,
      { title: "Fleet Owner Not Found" },
    );
  }
}

export class CarNotFoundException extends CarException {
  constructor() {
    super(
      CarErrorCode.CAR_NOT_FOUND,
      "Car not found or you do not have access to it",
      HttpStatus.NOT_FOUND,
      { title: "Car Not Found" },
    );
  }
}

export class CarFetchFailedException extends CarException {
  constructor() {
    super(
      CarErrorCode.CAR_FETCH_FAILED,
      "An unexpected error occurred while fetching cars",
      HttpStatus.INTERNAL_SERVER_ERROR,
      { title: "Car Fetch Failed" },
    );
  }
}

export class CarCreateFailedException extends CarException {
  constructor() {
    super(
      CarErrorCode.CAR_CREATE_FAILED,
      "An unexpected error occurred while creating the car",
      HttpStatus.INTERNAL_SERVER_ERROR,
      { title: "Car Create Failed" },
    );
  }
}

export class CarUpdateFailedException extends CarException {
  constructor() {
    super(
      CarErrorCode.CAR_UPDATE_FAILED,
      "An unexpected error occurred while updating the car",
      HttpStatus.INTERNAL_SERVER_ERROR,
      { title: "Car Update Failed" },
    );
  }
}

export class OwnerDriverCarLimitReachedException extends CarException {
  constructor() {
    super(
      CarErrorCode.OWNER_DRIVER_CAR_LIMIT_REACHED,
      "Owner-drivers can only have 1 car. Delete your existing car first or contact support to upgrade to a fleet owner account.",
      HttpStatus.CONFLICT,
      { title: "Owner Driver Car Limit Reached" },
    );
  }
}

export class RegistrationNumberAlreadyExistsException extends CarException {
  constructor(registrationNumber: string) {
    super(
      CarErrorCode.REGISTRATION_NUMBER_ALREADY_EXISTS,
      `A car with registration number ${registrationNumber} already exists in your fleet`,
      HttpStatus.CONFLICT,
      { title: "Registration Number Already Exists" },
    );
  }
}
