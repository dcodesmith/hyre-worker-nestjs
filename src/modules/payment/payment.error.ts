import { HttpStatus } from "@nestjs/common";
import { AppException } from "../../common/errors/app.exception";

export const PaymentErrorCode = {
  PAYOUT_BANK_DETAILS_REQUIRED: "PAYOUT_BANK_DETAILS_REQUIRED",
  PAYOUT_TRANSACTION_RECOVERY_FAILED: "PAYOUT_TRANSACTION_RECOVERY_FAILED",
  PAYOUT_INITIATION_FAILED: "PAYOUT_INITIATION_FAILED",
  PAYOUT_BOOKING_NOT_FOUND: "PAYOUT_BOOKING_NOT_FOUND",
  PAYOUT_BOOKING_NOT_COMPLETED: "PAYOUT_BOOKING_NOT_COMPLETED",
  PAYOUT_PROCESSING_IN_PROGRESS: "PAYOUT_PROCESSING_IN_PROGRESS",
  PAYOUT_PROCESSING_CLAIM_LOST: "PAYOUT_PROCESSING_CLAIM_LOST",
} as const;

export class PaymentException extends AppException {}

export class PayoutBankDetailsRequiredException extends PaymentException {
  constructor(bookingId: string) {
    super(
      PaymentErrorCode.PAYOUT_BANK_DETAILS_REQUIRED,
      "Verified bank details are required before payout processing",
      HttpStatus.CONFLICT,
      {
        title: "Payout Bank Details Required",
        details: { bookingId },
      },
    );
  }
}

export class PayoutTransactionRecoveryFailedException extends PaymentException {
  constructor(bookingId: string) {
    super(
      PaymentErrorCode.PAYOUT_TRANSACTION_RECOVERY_FAILED,
      "Failed to recover the existing payout transaction",
      HttpStatus.INTERNAL_SERVER_ERROR,
      {
        title: "Payout Transaction Recovery Failed",
        details: { bookingId },
      },
    );
  }
}

export class PayoutInitiationFailedException extends PaymentException {
  constructor(bookingId: string, reason: string) {
    super(
      PaymentErrorCode.PAYOUT_INITIATION_FAILED,
      `Payout initiation failed: ${reason}`,
      HttpStatus.BAD_GATEWAY,
      {
        title: "Payout Initiation Failed",
        details: { bookingId, reason },
      },
    );
  }
}

export class PayoutBookingNotFoundException extends PaymentException {
  constructor(bookingId: string) {
    super(
      PaymentErrorCode.PAYOUT_BOOKING_NOT_FOUND,
      "Booking not found when processing payout",
      HttpStatus.NOT_FOUND,
      {
        title: "Payout Booking Not Found",
        details: { bookingId },
      },
    );
  }
}

export class PayoutBookingNotCompletedException extends PaymentException {
  constructor(bookingId: string) {
    super(
      PaymentErrorCode.PAYOUT_BOOKING_NOT_COMPLETED,
      "Booking must be completed before payout processing",
      HttpStatus.CONFLICT,
      {
        title: "Payout Booking Not Completed",
        details: { bookingId },
      },
    );
  }
}

export class PayoutProcessingInProgressException extends PaymentException {
  constructor(bookingId: string) {
    super(
      PaymentErrorCode.PAYOUT_PROCESSING_IN_PROGRESS,
      "Payout processing is already in progress",
      HttpStatus.CONFLICT,
      {
        title: "Payout Processing In Progress",
        details: { bookingId },
      },
    );
  }
}

export class PayoutProcessingClaimLostException extends PaymentException {
  constructor(bookingId: string) {
    super(
      PaymentErrorCode.PAYOUT_PROCESSING_CLAIM_LOST,
      "Payout processing claim is no longer active",
      HttpStatus.CONFLICT,
      {
        title: "Payout Processing Claim Lost",
        details: { bookingId },
      },
    );
  }
}
