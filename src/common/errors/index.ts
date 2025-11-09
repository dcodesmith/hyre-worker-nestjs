/**
 * Central export for base error class only.
 * Module-specific error codes and exceptions are co-located with their modules:
 * - Job errors: src/modules/job/errors (JobException, JobErrorCodes)
 * - Status Change errors: src/modules/status-change/errors (StatusChangeException, StatusChangeErrorCodes)
 * - Reminder errors: src/modules/reminder/errors (ReminderException, ReminderErrorCodes)
 */
export * from "./app.exception";
