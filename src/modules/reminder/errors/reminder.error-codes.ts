/**
 * Reminder module error codes
 *
 * Error code format: REMINDER.{CATEGORY}.{SPECIFIC_ERROR}
 *
 * These errors are for actual failure scenarios in reminder processing,
 * not for empty query results (which are normal, not errors).
 */
export enum ReminderErrorCodes {
  // Notification queue errors
  NOTIFICATION_QUEUE_FAILED = "REMINDER.NOTIFICATION.QUEUE_FAILED",
}
