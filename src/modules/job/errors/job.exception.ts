import { HttpStatus } from "@nestjs/common";
import { AppException } from "../../../common/errors/app.exception";
import { JobErrorCodes } from "./job.error-codes";

/**
 * Job module specific exception class.
 * Provides convenient factory methods for common job-related errors.
 */
export class JobException extends AppException {
  constructor(
    errorCode: JobErrorCodes,
    message: string,
    status: HttpStatus = HttpStatus.INTERNAL_SERVER_ERROR,
    details?: Record<string, any>,
  ) {
    super(errorCode, message, status, details);
  }

  /**
   * Factory method for invalid job type errors
   */
  static invalidType(jobType: string, validTypes: string[]): JobException {
    return new JobException(
      JobErrorCodes.INVALID_TYPE,
      `Invalid job type: "${jobType}". Valid types are: ${validTypes.join(", ")}`,
      HttpStatus.BAD_REQUEST,
      { jobType, validTypes },
    );
  }

  /**
   * Factory method for queue enqueue failures
   */
  static enqueueFailed(jobName: string, reason?: string): JobException {
    return new JobException(
      JobErrorCodes.ENQUEUE_FAILED,
      `Failed to enqueue job: ${jobName}${reason ? `. Reason: ${reason}` : ""}`,
      HttpStatus.INTERNAL_SERVER_ERROR,
      { jobName, reason },
    );
  }

  /**
   * Factory method for manual triggers disabled
   */
  static manualTriggersDisabled(): JobException {
    return new JobException(
      JobErrorCodes.MANUAL_TRIGGERS_DISABLED,
      "Manual trigger endpoints are disabled",
      HttpStatus.FORBIDDEN,
    );
  }

  /**
   * Factory method for rate limit exceeded
   */
  static rateLimitExceeded(jobType: string, retryAfter?: number): JobException {
    return new JobException(
      JobErrorCodes.RATE_LIMIT_EXCEEDED,
      `Rate limit exceeded for job type: ${jobType}`,
      HttpStatus.TOO_MANY_REQUESTS,
      { jobType, retryAfter },
    );
  }
}
