import { HttpStatus } from "@nestjs/common";
import { AppException } from "../../common/errors/app.exception";

export const AccountVerificationErrorCode = {
  EMAIL_NOT_VERIFIED: "ACCOUNT_EMAIL_NOT_VERIFIED",
  PHONE_NOT_VERIFIED: "ACCOUNT_PHONE_NOT_VERIFIED",
  PHONE_CODE_INVALID: "PHONE_VERIFICATION_CODE_INVALID",
  PHONE_PROVIDER_UNAVAILABLE: "PHONE_VERIFICATION_PROVIDER_UNAVAILABLE",
  DOCUMENT_INVALID: "ACCOUNT_DOCUMENT_INVALID",
  DRIVER_LICENSE_REQUIRED: "OWNER_DRIVER_LICENSE_REQUIRED",
  ACCOUNT_ALREADY_VERIFIED: "ACCOUNT_ALREADY_VERIFIED",
  BANK_ACCOUNT_UNRESOLVED: "BANK_ACCOUNT_UNRESOLVED",
  BANK_PROVIDER_UNAVAILABLE: "BANK_ACCOUNT_PROVIDER_UNAVAILABLE",
  BANK_ACCOUNT_NAME_MISMATCH: "BANK_ACCOUNT_NAME_MISMATCH",
  BUSINESS_INACTIVE: "BUSINESS_INACTIVE",
  BUSINESS_NAME_MISMATCH: "BUSINESS_NAME_MISMATCH",
  REVIEW_NOT_FOUND: "ACCOUNT_VERIFICATION_REVIEW_NOT_FOUND",
  REVIEW_NOT_PENDING: "ACCOUNT_VERIFICATION_REVIEW_NOT_PENDING",
  REVIEW_PENDING: "ACCOUNT_VERIFICATION_REVIEW_PENDING",
  DRIVER_LICENSE_NOT_APPROVED: "OWNER_DRIVER_LICENSE_NOT_APPROVED",
  MANUAL_REVIEW_REJECTED: "ACCOUNT_MANUAL_REVIEW_REJECTED",
  OPERATION_FAILED: "ACCOUNT_VERIFICATION_FAILED",
} as const;

export class AccountVerificationException extends AppException {}

export class AccountEmailNotVerifiedException extends AccountVerificationException {
  constructor() {
    super(
      AccountVerificationErrorCode.EMAIL_NOT_VERIFIED,
      "Verify your email before completing account verification",
      HttpStatus.UNPROCESSABLE_ENTITY,
      { title: "Email Not Verified" },
    );
  }
}

export class AccountPhoneNotVerifiedException extends AccountVerificationException {
  constructor() {
    super(
      AccountVerificationErrorCode.PHONE_NOT_VERIFIED,
      "Verify your phone number before completing account verification",
      HttpStatus.UNPROCESSABLE_ENTITY,
      { title: "Phone Not Verified" },
    );
  }
}

export class PhoneVerificationCodeInvalidException extends AccountVerificationException {
  constructor() {
    super(
      AccountVerificationErrorCode.PHONE_CODE_INVALID,
      "The phone verification code is invalid or expired",
      HttpStatus.UNPROCESSABLE_ENTITY,
      { title: "Invalid Verification Code" },
    );
  }
}

export class PhoneVerificationProviderUnavailableException extends AccountVerificationException {
  constructor() {
    super(
      AccountVerificationErrorCode.PHONE_PROVIDER_UNAVAILABLE,
      "Phone verification is temporarily unavailable",
      HttpStatus.BAD_GATEWAY,
      { title: "Phone Verification Unavailable" },
    );
  }
}

export class AccountDocumentInvalidException extends AccountVerificationException {
  constructor(message: string) {
    super(AccountVerificationErrorCode.DOCUMENT_INVALID, message, HttpStatus.BAD_REQUEST, {
      title: "Invalid Account Document",
    });
  }
}

export class OwnerDriverLicenseRequiredException extends AccountVerificationException {
  constructor() {
    super(
      AccountVerificationErrorCode.DRIVER_LICENSE_REQUIRED,
      "A driver's licence is required for owner-drivers",
      HttpStatus.BAD_REQUEST,
      { title: "Driver's Licence Required" },
    );
  }
}

export class AccountAlreadyVerifiedException extends AccountVerificationException {
  constructor() {
    super(
      AccountVerificationErrorCode.ACCOUNT_ALREADY_VERIFIED,
      "This fleet-owner account is already verified",
      HttpStatus.CONFLICT,
      { title: "Account Already Verified" },
    );
  }
}

export class BankAccountUnresolvedException extends AccountVerificationException {
  constructor() {
    super(
      AccountVerificationErrorCode.BANK_ACCOUNT_UNRESOLVED,
      "The supplied bank account could not be verified",
      HttpStatus.UNPROCESSABLE_ENTITY,
      { title: "Bank Account Not Verified" },
    );
  }
}

export class BankAccountProviderUnavailableException extends AccountVerificationException {
  constructor() {
    super(
      AccountVerificationErrorCode.BANK_PROVIDER_UNAVAILABLE,
      "Bank account verification is temporarily unavailable",
      HttpStatus.BAD_GATEWAY,
      { title: "Bank Verification Unavailable" },
    );
  }
}

export class BankAccountNameMismatchException extends AccountVerificationException {
  constructor() {
    super(
      AccountVerificationErrorCode.BANK_ACCOUNT_NAME_MISMATCH,
      "The bank account name does not match the verified account identity",
      HttpStatus.UNPROCESSABLE_ENTITY,
      { title: "Bank Account Name Mismatch" },
    );
  }
}

export class BusinessInactiveException extends AccountVerificationException {
  constructor() {
    super(
      AccountVerificationErrorCode.BUSINESS_INACTIVE,
      "The business is not active on the CAC record",
      HttpStatus.UNPROCESSABLE_ENTITY,
      { title: "Business Not Active" },
    );
  }
}

export class BusinessNameMismatchException extends AccountVerificationException {
  constructor() {
    super(
      AccountVerificationErrorCode.BUSINESS_NAME_MISMATCH,
      "The supplied business name does not match the CAC record",
      HttpStatus.UNPROCESSABLE_ENTITY,
      { title: "Business Name Mismatch" },
    );
  }
}

export class AccountVerificationOperationFailedException extends AccountVerificationException {
  constructor() {
    super(
      AccountVerificationErrorCode.OPERATION_FAILED,
      "An unexpected account verification error occurred",
      HttpStatus.INTERNAL_SERVER_ERROR,
      { title: "Account Verification Failed" },
    );
  }
}

export class AccountVerificationReviewNotFoundException extends AccountVerificationException {
  constructor() {
    super(
      AccountVerificationErrorCode.REVIEW_NOT_FOUND,
      "Account verification review not found",
      HttpStatus.NOT_FOUND,
      { title: "Account Verification Not Found" },
    );
  }
}

export class AccountVerificationReviewNotPendingException extends AccountVerificationException {
  constructor() {
    super(
      AccountVerificationErrorCode.REVIEW_NOT_PENDING,
      "This account verification is not awaiting review",
      HttpStatus.CONFLICT,
      { title: "Account Verification Not Pending" },
    );
  }
}

export class AccountVerificationReviewPendingException extends AccountVerificationException {
  constructor() {
    super(
      AccountVerificationErrorCode.REVIEW_PENDING,
      "An account verification is awaiting manual review",
      HttpStatus.CONFLICT,
      { title: "Account Verification Review Pending" },
    );
  }
}

export class OwnerDriverLicenseNotApprovedException extends AccountVerificationException {
  constructor() {
    super(
      AccountVerificationErrorCode.DRIVER_LICENSE_NOT_APPROVED,
      "Approve the owner's driver's licence before approving this account",
      HttpStatus.UNPROCESSABLE_ENTITY,
      { title: "Driver's Licence Not Approved" },
    );
  }
}

export class AccountManualReviewRejectedException extends AccountVerificationException {
  constructor() {
    super(
      AccountVerificationErrorCode.MANUAL_REVIEW_REJECTED,
      "The account verification was rejected during manual review",
      HttpStatus.UNPROCESSABLE_ENTITY,
      { title: "Account Verification Rejected" },
    );
  }
}
