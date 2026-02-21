import { HttpStatus } from "@nestjs/common";
import { AppException } from "../../common/errors/app.exception";

export const RatesErrorCode = {
  RATES_FETCH_FAILED: "RATES_FETCH_FAILED",
  RATE_NOT_FOUND: "RATE_NOT_FOUND",
  RATE_CREATE_FAILED: "RATE_CREATE_FAILED",
  RATE_UPDATE_FAILED: "RATE_UPDATE_FAILED",
  RATE_DATE_OVERLAP: "RATE_DATE_OVERLAP",
  RATE_ALREADY_ENDED: "RATE_ALREADY_ENDED",
  RATE_NOT_YET_ACTIVE: "RATE_NOT_YET_ACTIVE",
  RATE_VALIDATION_ERROR: "RATE_VALIDATION_ERROR",
} as const;

export class RatesException extends AppException {}

export class RatesFetchFailedException extends RatesException {
  constructor() {
    super(
      RatesErrorCode.RATES_FETCH_FAILED,
      "An unexpected error occurred while fetching rates",
      HttpStatus.INTERNAL_SERVER_ERROR,
      { title: "Rates Fetch Failed" },
    );
  }
}

export class RateNotFoundException extends RatesException {
  constructor() {
    super(RatesErrorCode.RATE_NOT_FOUND, "Rate not found", HttpStatus.NOT_FOUND, {
      title: "Rate Not Found",
    });
  }
}

export class RateCreateFailedException extends RatesException {
  constructor() {
    super(
      RatesErrorCode.RATE_CREATE_FAILED,
      "An unexpected error occurred while creating the rate",
      HttpStatus.INTERNAL_SERVER_ERROR,
      { title: "Rate Create Failed" },
    );
  }
}

export class RateUpdateFailedException extends RatesException {
  constructor() {
    super(
      RatesErrorCode.RATE_UPDATE_FAILED,
      "An unexpected error occurred while updating the rate",
      HttpStatus.INTERNAL_SERVER_ERROR,
      { title: "Rate Update Failed" },
    );
  }
}

export class RateDateOverlapException extends RatesException {
  constructor(detail: string) {
    super(RatesErrorCode.RATE_DATE_OVERLAP, detail, HttpStatus.CONFLICT, {
      title: "Rate Date Overlap",
    });
  }
}

export class RateAlreadyEndedException extends RatesException {
  constructor() {
    super(
      RatesErrorCode.RATE_ALREADY_ENDED,
      "This rate has already been ended",
      HttpStatus.CONFLICT,
      { title: "Rate Already Ended" },
    );
  }
}

export class RateNotYetActiveException extends RatesException {
  constructor() {
    super(
      RatesErrorCode.RATE_NOT_YET_ACTIVE,
      "Cannot end a rate that has not started yet",
      HttpStatus.CONFLICT,
      { title: "Rate Not Yet Active" },
    );
  }
}
