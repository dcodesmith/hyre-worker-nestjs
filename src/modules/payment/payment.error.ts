import { HttpStatus } from "@nestjs/common";
import { AppException } from "../../common/errors/app.exception";
import type { FieldError } from "../../common/errors/problem-details.interface";

export const PaymentErrorCode = {
  PAYMENT_AMOUNT_MISMATCH: "PAYMENT_AMOUNT_MISMATCH",
  PAYMENT_NOT_FOUND: "PAYMENT_NOT_FOUND",
  PAYMENT_ACCESS_FORBIDDEN: "PAYMENT_ACCESS_FORBIDDEN",
  PAYMENT_BOOKING_NOT_FOUND: "PAYMENT_BOOKING_NOT_FOUND",
  PAYMENT_EXTENSION_NOT_FOUND: "PAYMENT_EXTENSION_NOT_FOUND",
  PAYMENT_ENTITY_ACCESS_FORBIDDEN: "PAYMENT_ENTITY_ACCESS_FORBIDDEN",
  PAYMENT_ENTITY_NOT_PAYABLE: "PAYMENT_ENTITY_NOT_PAYABLE",
  PAYMENT_ENTITY_ALREADY_PAID: "PAYMENT_ENTITY_ALREADY_PAID",
  REFUND_PAYMENT_NOT_SUCCESSFUL: "REFUND_PAYMENT_NOT_SUCCESSFUL",
  REFUND_CHARGED_AMOUNT_MISSING: "REFUND_CHARGED_AMOUNT_MISSING",
  REFUND_AMOUNT_EXCEEDS_CHARGE: "REFUND_AMOUNT_EXCEEDS_CHARGE",
  REFUND_PROVIDER_REFERENCE_MISSING: "REFUND_PROVIDER_REFERENCE_MISSING",
  REFUND_RESERVATION_CONFLICT: "REFUND_RESERVATION_CONFLICT",
  PAYOUT_BANK_DETAILS_REQUIRED: "PAYOUT_BANK_DETAILS_REQUIRED",
  PAYOUT_TRANSACTION_RECOVERY_FAILED: "PAYOUT_TRANSACTION_RECOVERY_FAILED",
  PAYOUT_INITIATION_FAILED: "PAYOUT_INITIATION_FAILED",
  PAYOUT_BOOKING_NOT_FOUND: "PAYOUT_BOOKING_NOT_FOUND",
  PAYOUT_BOOKING_NOT_COMPLETED: "PAYOUT_BOOKING_NOT_COMPLETED",
  PAYOUT_PROCESSING_IN_PROGRESS: "PAYOUT_PROCESSING_IN_PROGRESS",
  PAYOUT_PROCESSING_CLAIM_LOST: "PAYOUT_PROCESSING_CLAIM_LOST",
  FLUTTERWAVE_WEBHOOK_PAYLOAD_INVALID: "FLUTTERWAVE_WEBHOOK_PAYLOAD_INVALID",
  REFUND_PROVIDER_ID_MISSING: "REFUND_PROVIDER_ID_MISSING",
  REFUND_RECONCILIATION_REQUIRED: "REFUND_RECONCILIATION_REQUIRED",
  REFUND_WEBHOOK_PAYMENT_NOT_FOUND: "REFUND_WEBHOOK_PAYMENT_NOT_FOUND",
  REFUND_DOMAIN_STATE_MISMATCH: "REFUND_DOMAIN_STATE_MISMATCH",
} as const;

export class PaymentException extends AppException {}

export class PaymentAmountMismatchException extends PaymentException {
  constructor(expectedAmount: number, receivedAmount: number) {
    super(
      PaymentErrorCode.PAYMENT_AMOUNT_MISMATCH,
      `Payment amount mismatch: expected ${expectedAmount}, received ${receivedAmount}`,
      HttpStatus.BAD_REQUEST,
      {
        title: "Payment Amount Mismatch",
        details: { expectedAmount, receivedAmount },
      },
    );
  }
}

export class PaymentNotFoundException extends PaymentException {
  constructor(txRef: string) {
    super(PaymentErrorCode.PAYMENT_NOT_FOUND, "Payment not found", HttpStatus.NOT_FOUND, {
      title: "Payment Not Found",
      details: { txRef },
    });
  }
}

export class PaymentAccessForbiddenException extends PaymentException {
  constructor(paymentId: string, action: "view" | "refund") {
    super(
      PaymentErrorCode.PAYMENT_ACCESS_FORBIDDEN,
      `You do not have permission to ${action} this payment`,
      HttpStatus.FORBIDDEN,
      {
        title: "Payment Access Forbidden",
        details: { paymentId, action },
      },
    );
  }
}

export class PaymentBookingNotFoundException extends PaymentException {
  constructor(bookingId: string) {
    super(PaymentErrorCode.PAYMENT_BOOKING_NOT_FOUND, "Booking not found", HttpStatus.NOT_FOUND, {
      title: "Payment Booking Not Found",
      details: { bookingId },
    });
  }
}

export class PaymentExtensionNotFoundException extends PaymentException {
  constructor(extensionId: string) {
    super(
      PaymentErrorCode.PAYMENT_EXTENSION_NOT_FOUND,
      "Extension not found",
      HttpStatus.NOT_FOUND,
      {
        title: "Payment Extension Not Found",
        details: { extensionId },
      },
    );
  }
}

export class PaymentEntityAccessForbiddenException extends PaymentException {
  constructor(entityType: "booking" | "extension", entityId: string) {
    super(
      PaymentErrorCode.PAYMENT_ENTITY_ACCESS_FORBIDDEN,
      `You do not have permission to pay for this ${entityType}`,
      HttpStatus.FORBIDDEN,
      {
        title: "Payment Entity Access Forbidden",
        details: { entityType, entityId },
      },
    );
  }
}

export class PaymentEntityNotPayableException extends PaymentException {
  constructor(entityType: "booking" | "extension", entityId: string, reason: string) {
    super(
      PaymentErrorCode.PAYMENT_ENTITY_NOT_PAYABLE,
      `Cannot pay for ${entityType}: ${reason}`,
      HttpStatus.CONFLICT,
      {
        title: "Payment Entity Not Payable",
        details: { entityType, entityId, reason },
      },
    );
  }
}

export class PaymentEntityAlreadyPaidException extends PaymentException {
  constructor(entityType: "booking" | "extension", entityId: string) {
    super(
      PaymentErrorCode.PAYMENT_ENTITY_ALREADY_PAID,
      `This ${entityType} has already been paid`,
      HttpStatus.CONFLICT,
      {
        title: "Payment Entity Already Paid",
        details: { entityType, entityId },
      },
    );
  }
}

export class RefundPaymentNotSuccessfulException extends PaymentException {
  constructor(paymentId: string, status: string) {
    super(
      PaymentErrorCode.REFUND_PAYMENT_NOT_SUCCESSFUL,
      "Cannot refund a payment that is not successful",
      HttpStatus.CONFLICT,
      {
        title: "Refund Payment Not Successful",
        details: { paymentId, status },
      },
    );
  }
}

export class RefundChargedAmountMissingException extends PaymentException {
  constructor(paymentId: string) {
    super(
      PaymentErrorCode.REFUND_CHARGED_AMOUNT_MISSING,
      "Payment has no charged amount recorded",
      HttpStatus.CONFLICT,
      {
        title: "Refund Charged Amount Missing",
        details: { paymentId },
      },
    );
  }
}

export class RefundAmountExceedsChargeException extends PaymentException {
  constructor(paymentId: string, refundAmount: number, chargedAmount: number) {
    super(
      PaymentErrorCode.REFUND_AMOUNT_EXCEEDS_CHARGE,
      "Refund amount cannot exceed the amount charged",
      HttpStatus.BAD_REQUEST,
      {
        title: "Refund Amount Exceeds Charge",
        details: { paymentId, refundAmount, chargedAmount },
      },
    );
  }
}

export class RefundProviderReferenceMissingException extends PaymentException {
  constructor(paymentId: string) {
    super(
      PaymentErrorCode.REFUND_PROVIDER_REFERENCE_MISSING,
      "Payment does not have a provider reference",
      HttpStatus.CONFLICT,
      {
        title: "Refund Provider Reference Missing",
        details: { paymentId },
      },
    );
  }
}

export class RefundReservationConflictException extends PaymentException {
  constructor(paymentId: string) {
    super(
      PaymentErrorCode.REFUND_RESERVATION_CONFLICT,
      "Refund already in progress or payment status changed",
      HttpStatus.CONFLICT,
      {
        title: "Refund Reservation Conflict",
        details: { paymentId },
      },
    );
  }
}

export class InvalidFlutterwaveWebhookPayloadException extends PaymentException {
  constructor(errors: FieldError[]) {
    super(
      PaymentErrorCode.FLUTTERWAVE_WEBHOOK_PAYLOAD_INVALID,
      "The Flutterwave webhook payload is invalid",
      HttpStatus.BAD_REQUEST,
      {
        title: "Invalid Flutterwave Webhook Payload",
        errors,
      },
    );
  }
}

export class RefundProviderIdMissingException extends PaymentException {
  constructor(paymentId: string) {
    super(
      PaymentErrorCode.REFUND_PROVIDER_ID_MISSING,
      "Flutterwave accepted the refund without returning a refund ID",
      HttpStatus.BAD_GATEWAY,
      {
        title: "Refund Provider ID Missing",
        details: { paymentId },
      },
    );
  }
}

export class RefundReconciliationRequiredException extends PaymentException {
  constructor(paymentId: string) {
    super(
      PaymentErrorCode.REFUND_RECONCILIATION_REQUIRED,
      "This refund has an uncertain provider outcome and must be reconciled before another attempt",
      HttpStatus.CONFLICT,
      {
        title: "Refund Reconciliation Required",
        details: { paymentId },
      },
    );
  }
}

export class RefundWebhookPaymentNotFoundException extends PaymentException {
  constructor(transactionId: number) {
    super(
      PaymentErrorCode.REFUND_WEBHOOK_PAYMENT_NOT_FOUND,
      "No local payment matches the Flutterwave refund transaction",
      HttpStatus.SERVICE_UNAVAILABLE,
      {
        title: "Refund Webhook Payment Not Found",
        details: { transactionId },
      },
    );
  }
}

export class RefundDomainStateMismatchException extends PaymentException {
  constructor(paymentId: string) {
    super(
      PaymentErrorCode.REFUND_DOMAIN_STATE_MISMATCH,
      "The booking payment state changed before the refund could be reserved",
      HttpStatus.CONFLICT,
      {
        title: "Refund Domain State Mismatch",
        details: { paymentId },
      },
    );
  }
}

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
