import { HttpStatus } from "@nestjs/common";
import { AppException } from "../../../common/errors/app.exception";
import { JobErrorCodes } from "./job.error-codes";

/**
 * Base exception for job-related errors.
 */
export class JobException extends AppException {
  constructor(
    errorCode: JobErrorCodes,
    message: string,
    status: HttpStatus = HttpStatus.INTERNAL_SERVER_ERROR,
    details?: Record<string, unknown>,
  ) {
    super(errorCode, message, status, details ? { details } : undefined);
  }
}

/**
 * Exception for invalid job type errors.
 */
export class InvalidJobTypeException extends JobException {
  constructor(jobType: string, validTypes: string[]) {
    super(
      JobErrorCodes.INVALID_TYPE,
      `Invalid job type: "${jobType}". Valid types are: ${validTypes.join(", ")}`,
      HttpStatus.BAD_REQUEST,
      { jobType, validTypes },
    );
  }
}

/**
 * Exception for queue enqueue failures.
 */
export class JobEnqueueFailedException extends JobException {
  constructor(jobName: string, reason?: string) {
    const reasonSuffix = reason ? `. Reason: ${reason}` : "";
    super(
      JobErrorCodes.ENQUEUE_FAILED,
      `Failed to enqueue job: ${jobName}${reasonSuffix}`,
      HttpStatus.INTERNAL_SERVER_ERROR,
      { jobName, reason },
    );
  }
}

/**
 * Exception for manual triggers disabled.
 */
export class ManualTriggersDisabledException extends JobException {
  constructor() {
    super(
      JobErrorCodes.MANUAL_TRIGGERS_DISABLED,
      "Manual trigger endpoints are disabled",
      HttpStatus.FORBIDDEN,
    );
  }
}

/**
 * Exception for rate limit exceeded.
 */
export class JobRateLimitExceededException extends JobException {
  constructor(jobType: string, retryAfter?: number) {
    super(
      JobErrorCodes.RATE_LIMIT_EXCEEDED,
      `Rate limit exceeded for job type: ${jobType}`,
      HttpStatus.TOO_MANY_REQUESTS,
      { jobType, retryAfter },
    );
  }
}
