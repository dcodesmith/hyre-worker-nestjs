/**
 * Status Change module error codes
 *
 * Error code format: STATUS_CHANGE.{CATEGORY}.{SPECIFIC_ERROR}
 *
 * These errors are for actual failure scenarios in status change processing,
 * not for empty query results (which are normal, not errors).
 */
export enum StatusChangeErrorCodes {
  // Notification errors
  NOTIFICATION_QUEUE_FAILED = "STATUS_CHANGE.NOTIFICATION.QUEUE_FAILED",

  // Payment errors (for future use)
  PAYMENT_REQUIRED = "STATUS_CHANGE.PAYMENT.REQUIRED",
  PAYMENT_FAILED = "STATUS_CHANGE.PAYMENT.FAILED",
}
