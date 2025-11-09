import { HttpStatus } from "@nestjs/common";
import { AppException } from "../../../common/errors/app.exception";
import { StatusChangeErrorCodes } from "./status-change.error-codes";

/**
 * Status Change module specific exception class.
 * Provides convenient factory methods for status change errors.
 */
export class StatusChangeException extends AppException {
  constructor(
    errorCode: StatusChangeErrorCodes,
    message: string,
    status: HttpStatus = HttpStatus.INTERNAL_SERVER_ERROR,
    details?: Record<string, any>,
  ) {
    super(errorCode, message, status, details);
  }

  /**
   * Factory method for notification queue failures
   */
  static notificationQueueFailed(bookingId: string, reason?: string): StatusChangeException {
    return new StatusChangeException(
      StatusChangeErrorCodes.NOTIFICATION_QUEUE_FAILED,
      `Failed to queue booking status notification for booking: ${bookingId}${reason ? `. Reason: ${reason}` : ""}`,
      HttpStatus.INTERNAL_SERVER_ERROR,
      { bookingId, reason },
    );
  }

  /**
   * Factory method for payment required errors
   */
  static paymentRequired(bookingId: string): StatusChangeException {
    return new StatusChangeException(
      StatusChangeErrorCodes.PAYMENT_REQUIRED,
      `Payment required for booking: ${bookingId}`,
      HttpStatus.PAYMENT_REQUIRED,
      { bookingId },
    );
  }

  /**
   * Factory method for payment failed errors
   */
  static paymentFailed(bookingId: string, reason?: string): StatusChangeException {
    return new StatusChangeException(
      StatusChangeErrorCodes.PAYMENT_FAILED,
      `Payment failed for booking: ${bookingId}${reason ? `. Reason: ${reason}` : ""}`,
      HttpStatus.BAD_REQUEST,
      { bookingId, reason },
    );
  }
}
