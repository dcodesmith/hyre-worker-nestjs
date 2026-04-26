import { HttpStatus } from "@nestjs/common";
import { AppException } from "../../common/errors/app.exception";

export const StatusChangeErrorCode = {
  UNKNOWN_JOB_TYPE: "STATUS_CHANGE_UNKNOWN_JOB_TYPE",
  INVALID_JOB_PAYLOAD: "STATUS_CHANGE_INVALID_JOB_PAYLOAD",
  JOB_PROCESSING_FAILED: "STATUS_CHANGE_JOB_PROCESSING_FAILED",
  JOB_SCHEDULING_FAILED: "STATUS_CHANGE_JOB_SCHEDULING_FAILED",
  CONFIRMED_TO_ACTIVE_FAILED: "STATUS_CHANGE_CONFIRMED_TO_ACTIVE_FAILED",
  ACTIVE_TO_COMPLETED_FAILED: "STATUS_CHANGE_ACTIVE_TO_COMPLETED_FAILED",
  AIRPORT_ACTIVATION_FAILED: "STATUS_CHANGE_AIRPORT_ACTIVATION_FAILED",
} as const;

export class StatusChangeException extends AppException {}

export class UnknownStatusUpdateJobTypeException extends StatusChangeException {
  constructor(jobName: string) {
    super(
      StatusChangeErrorCode.UNKNOWN_JOB_TYPE,
      `Unknown status update job type: ${jobName}`,
      HttpStatus.BAD_REQUEST,
      {
        title: "Unknown Status Update Job Type",
        details: { jobName },
      },
    );
  }
}

export class InvalidStatusUpdateJobPayloadException extends StatusChangeException {
  constructor(jobName: string) {
    super(
      StatusChangeErrorCode.INVALID_JOB_PAYLOAD,
      `Invalid job payload for ${jobName}`,
      HttpStatus.BAD_REQUEST,
      {
        title: "Invalid Status Update Job Payload",
        details: { jobName },
      },
    );
  }
}

export class StatusUpdateJobProcessingFailedException extends StatusChangeException {
  constructor(jobName: string, reason: string) {
    super(
      StatusChangeErrorCode.JOB_PROCESSING_FAILED,
      `Failed to process ${jobName} job: ${reason}`,
      HttpStatus.INTERNAL_SERVER_ERROR,
      {
        title: "Status Update Job Processing Failed",
        details: { jobName, reason },
      },
    );
  }
}

export class StatusUpdateSchedulingFailedException extends StatusChangeException {
  constructor(jobName: string, reason: string) {
    super(
      StatusChangeErrorCode.JOB_SCHEDULING_FAILED,
      `Failed to schedule ${jobName} job: ${reason}`,
      HttpStatus.INTERNAL_SERVER_ERROR,
      {
        title: "Status Update Job Scheduling Failed",
        details: { jobName, reason },
      },
    );
  }
}

export class ConfirmedToActiveUpdateFailedException extends StatusChangeException {
  constructor(reason: string) {
    super(
      StatusChangeErrorCode.CONFIRMED_TO_ACTIVE_FAILED,
      `Failed to update bookings from confirmed to active: ${reason}`,
      HttpStatus.INTERNAL_SERVER_ERROR,
      {
        title: "Confirmed To Active Update Failed",
        details: { reason },
      },
    );
  }
}

export class ActiveToCompletedUpdateFailedException extends StatusChangeException {
  constructor(reason: string) {
    super(
      StatusChangeErrorCode.ACTIVE_TO_COMPLETED_FAILED,
      `Failed to update bookings from active to completed: ${reason}`,
      HttpStatus.INTERNAL_SERVER_ERROR,
      {
        title: "Active To Completed Update Failed",
        details: { reason },
      },
    );
  }
}

export class AirportBookingActivationFailedException extends StatusChangeException {
  constructor(bookingId: string, reason: string) {
    super(
      StatusChangeErrorCode.AIRPORT_ACTIVATION_FAILED,
      `Failed to activate airport booking ${bookingId}: ${reason}`,
      HttpStatus.INTERNAL_SERVER_ERROR,
      {
        title: "Airport Booking Activation Failed",
        details: { bookingId, reason },
      },
    );
  }
}
