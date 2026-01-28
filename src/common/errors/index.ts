/**
 * Central export for base error class and shared error types.
 * Module-specific error codes and exceptions are co-located with their modules:
 * - Job errors: src/modules/job/errors (JobException, JobErrorCodes)
 * - Status Change errors: src/modules/status-change/errors (StatusChangeException, StatusChangeErrorCodes)
 * - Reminder errors: src/modules/reminder/errors (ReminderException, ReminderErrorCodes)
 * - Booking errors: src/modules/booking/booking.error (BookingException, BookingErrorCode)
 */
export * from "./app.exception";
export * from "./problem-details.interface";
