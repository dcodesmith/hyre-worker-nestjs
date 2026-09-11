import { HttpStatus } from "@nestjs/common";
import { AppException } from "../../common/errors/app.exception";

export const RatesErrorCode = {
  RATES_FETCH_FAILED: "RATES_FETCH_FAILED",
  RATE_CREATE_FAILED: "RATE_CREATE_FAILED",
  RATE_DATE_OVERLAP: "RATE_DATE_OVERLAP",
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

export class RateDateOverlapException extends RatesException {
  constructor(detail: string) {
    super(RatesErrorCode.RATE_DATE_OVERLAP, detail, HttpStatus.CONFLICT, {
      title: "Rate Date Overlap",
    });
  }
}
