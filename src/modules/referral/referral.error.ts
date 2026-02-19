import { HttpStatus } from "@nestjs/common";
import { AppException } from "../../common/errors/app.exception";

export const ReferralErrorCode = {
  INVALID_REFERRAL_CODE: "INVALID_REFERRAL_CODE",
  SELF_REFERRAL: "SELF_REFERRAL",
  REFERRAL_RATE_LIMIT_EXCEEDED: "REFERRAL_RATE_LIMIT_EXCEEDED",
  REFERRAL_VALIDATION_FAILED: "REFERRAL_VALIDATION_FAILED",
  REFERRAL_ELIGIBILITY_CHECK_FAILED: "REFERRAL_ELIGIBILITY_CHECK_FAILED",
  REFERRAL_USER_FETCH_FAILED: "REFERRAL_USER_FETCH_FAILED",
  REFERRAL_USER_NOT_FOUND: "REFERRAL_USER_NOT_FOUND",
} as const;

export class ReferralException extends AppException {
  constructor(errorCode: string, detail: string, status: HttpStatus, title: string) {
    super(errorCode, detail, status, {
      type: errorCode,
      title,
    });
  }
}

export class ReferralInvalidCodeException extends ReferralException {
  constructor() {
    super(
      ReferralErrorCode.INVALID_REFERRAL_CODE,
      "The referral code you entered is invalid.",
      HttpStatus.NOT_FOUND,
      "Referral Code Not Found",
    );
  }
}

export class ReferralSelfReferralException extends ReferralException {
  constructor() {
    super(
      ReferralErrorCode.SELF_REFERRAL,
      "You cannot refer yourself.",
      HttpStatus.BAD_REQUEST,
      "Invalid Referral Request",
    );
  }
}

export class ReferralRateLimitExceededException extends ReferralException {
  constructor() {
    super(
      ReferralErrorCode.REFERRAL_RATE_LIMIT_EXCEEDED,
      "Too many validation attempts. Please try again later.",
      HttpStatus.TOO_MANY_REQUESTS,
      "Too Many Referral Validation Attempts",
    );
  }
}

export class ReferralValidationFailedException extends ReferralException {
  constructor() {
    super(
      ReferralErrorCode.REFERRAL_VALIDATION_FAILED,
      "Failed to validate referral code",
      HttpStatus.INTERNAL_SERVER_ERROR,
      "Referral Validation Failed",
    );
  }
}

export class ReferralEligibilityCheckFailedException extends ReferralException {
  constructor() {
    super(
      ReferralErrorCode.REFERRAL_ELIGIBILITY_CHECK_FAILED,
      "Failed to check referral eligibility",
      HttpStatus.INTERNAL_SERVER_ERROR,
      "Referral Eligibility Check Failed",
    );
  }
}

export class ReferralUserFetchFailedException extends ReferralException {
  constructor() {
    super(
      ReferralErrorCode.REFERRAL_USER_FETCH_FAILED,
      "Failed to fetch referral information",
      HttpStatus.INTERNAL_SERVER_ERROR,
      "Referral Fetch Failed",
    );
  }
}

export class ReferralUserNotFoundException extends ReferralException {
  constructor() {
    super(
      ReferralErrorCode.REFERRAL_USER_NOT_FOUND,
      "User not found",
      HttpStatus.NOT_FOUND,
      "Referral User Not Found",
    );
  }
}
