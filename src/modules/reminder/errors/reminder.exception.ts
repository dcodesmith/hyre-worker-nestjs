import { HttpStatus } from "@nestjs/common";
import { AppException } from "../../../common/errors/app.exception";
import { ReminderErrorCodes } from "./reminder.error-codes";

/**
 * Reminder module specific exception class.
 * Provides convenient factory methods for reminder notification errors.
 */
export class ReminderException extends AppException {
  constructor(
    errorCode: ReminderErrorCodes,
    message: string,
    status: HttpStatus = HttpStatus.INTERNAL_SERVER_ERROR,
    details?: Record<string, any>,
  ) {
    super(errorCode, message, status, details);
  }

  /**
   * Factory method for notification queue failures
   */
  static notificationQueueFailed(legId: string, reminderType: string, reason?: string): ReminderException {
    return new ReminderException(
      ReminderErrorCodes.NOTIFICATION_QUEUE_FAILED,
      `Failed to queue ${reminderType} reminder notification for leg: ${legId}${reason ? `. Reason: ${reason}` : ""}`,
      HttpStatus.INTERNAL_SERVER_ERROR,
      { legId, reminderType, reason },
    );
  }
}
