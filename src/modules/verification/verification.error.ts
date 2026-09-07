import { HttpStatus } from "@nestjs/common";
import { AppException } from "../../common/errors/app.exception";
import type { FieldError } from "../../common/errors/problem-details.interface";
import type { PremblyErrorKind } from "../prembly/prembly.service";

export const VerificationErrorCode = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  VERIFICATION_NOT_FOUND: "VEHICLE_VERIFICATION_NOT_FOUND",
  IDEMPOTENCY_KEY_REUSED: "VERIFICATION_IDEMPOTENCY_KEY_REUSED",
  REQUEST_IN_PROGRESS: "VERIFICATION_REQUEST_IN_PROGRESS",
  PROVIDER_REJECTED: "PROVIDER_REJECTED",
  PROVIDER_INVALID_RESPONSE: "PROVIDER_INVALID_RESPONSE",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  VEHICLE_MISMATCH: "VEHICLE_MISMATCH",
  VEHICLE_NOT_ELIGIBLE: "VEHICLE_NOT_ELIGIBLE",
  VERIFICATION_EXPIRED: "VEHICLE_VERIFICATION_EXPIRED",
  VERIFICATION_ALREADY_USED: "VEHICLE_VERIFICATION_ALREADY_USED",
  INSURANCE_INACTIVE: "INSURANCE_INACTIVE",
  INSURANCE_VEHICLE_MISMATCH: "INSURANCE_VEHICLE_MISMATCH",
  OPERATION_FAILED: "VERIFICATION_OPERATION_FAILED",
} as const;

export class VerificationException extends AppException {}

export class VerificationValidationException extends VerificationException {
  constructor(errors: FieldError[]) {
    super(
      VerificationErrorCode.VALIDATION_ERROR,
      "One or more validation errors occurred",
      HttpStatus.BAD_REQUEST,
      { title: "Validation Failed", errors },
    );
  }
}

export class VehicleVerificationNotFoundException extends VerificationException {
  constructor() {
    super(
      VerificationErrorCode.VERIFICATION_NOT_FOUND,
      "Vehicle verification not found",
      HttpStatus.NOT_FOUND,
      { title: "Vehicle Verification Not Found" },
    );
  }
}

export class VerificationIdempotencyKeyReusedException extends VerificationException {
  constructor() {
    super(
      VerificationErrorCode.IDEMPOTENCY_KEY_REUSED,
      "This Idempotency-Key was already used with a different request",
      HttpStatus.CONFLICT,
      { title: "Idempotency Key Reused" },
    );
  }
}

export class VerificationRequestInProgressException extends VerificationException {
  readonly retryAfterSeconds = 5;

  constructor() {
    super(
      VerificationErrorCode.REQUEST_IN_PROGRESS,
      "An identical verification request is still being processed",
      HttpStatus.CONFLICT,
      { title: "Verification Request In Progress", details: { retryAfterSeconds: 5 } },
    );
  }
}

export class ProviderVerificationException extends VerificationException {
  constructor(kind: PremblyErrorKind) {
    const definition = {
      REJECTED: {
        code: VerificationErrorCode.PROVIDER_REJECTED,
        message: "Prembly could not verify the supplied information",
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        title: "Verification Rejected",
      },
      INVALID_RESPONSE: {
        code: VerificationErrorCode.PROVIDER_INVALID_RESPONSE,
        message: "Prembly returned an invalid response",
        status: HttpStatus.BAD_GATEWAY,
        title: "Invalid Provider Response",
      },
      UNAVAILABLE: {
        code: VerificationErrorCode.PROVIDER_UNAVAILABLE,
        message: "Prembly is temporarily unavailable",
        status: HttpStatus.BAD_GATEWAY,
        title: "Verification Provider Unavailable",
      },
    }[kind];

    super(definition.code, definition.message, definition.status, { title: definition.title });
  }
}

export class VehicleMismatchException extends VerificationException {
  constructor() {
    super(
      VerificationErrorCode.VEHICLE_MISMATCH,
      "Plate and chassis verification results do not match",
      HttpStatus.UNPROCESSABLE_ENTITY,
      { title: "Vehicle Details Mismatch" },
    );
  }
}

export class VehicleNotEligibleException extends VerificationException {
  constructor() {
    super(
      VerificationErrorCode.VEHICLE_NOT_ELIGIBLE,
      "This vehicle does not meet the minimum eligibility requirements",
      HttpStatus.UNPROCESSABLE_ENTITY,
      { title: "Vehicle Not Eligible" },
    );
  }
}

export class VehicleVerificationExpiredException extends VerificationException {
  constructor() {
    super(
      VerificationErrorCode.VERIFICATION_EXPIRED,
      "This vehicle verification has expired",
      HttpStatus.GONE,
      { title: "Vehicle Verification Expired" },
    );
  }
}

export class VehicleVerificationAlreadyUsedException extends VerificationException {
  constructor() {
    super(
      VerificationErrorCode.VERIFICATION_ALREADY_USED,
      "This vehicle verification has already been used",
      HttpStatus.CONFLICT,
      { title: "Vehicle Verification Already Used" },
    );
  }
}

export class InsuranceInactiveException extends VerificationException {
  constructor() {
    super(
      VerificationErrorCode.INSURANCE_INACTIVE,
      "The insurance policy is not active",
      HttpStatus.UNPROCESSABLE_ENTITY,
      { title: "Insurance Inactive" },
    );
  }
}

export class InsuranceVehicleMismatchException extends VerificationException {
  constructor() {
    super(
      VerificationErrorCode.INSURANCE_VEHICLE_MISMATCH,
      "The insurance policy does not match this vehicle",
      HttpStatus.UNPROCESSABLE_ENTITY,
      { title: "Insurance Vehicle Mismatch" },
    );
  }
}

export class VerificationOperationFailedException extends VerificationException {
  constructor() {
    super(
      VerificationErrorCode.OPERATION_FAILED,
      "An unexpected verification error occurred",
      HttpStatus.INTERNAL_SERVER_ERROR,
      { title: "Verification Failed" },
    );
  }
}
