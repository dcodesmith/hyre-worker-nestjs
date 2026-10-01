import { HttpStatus } from "@nestjs/common";
import { AppException } from "../../../common/errors/app.exception";

export const BookingAgentErrorCode = {
  BOOKING_AGENT_EXTRACTION_FAILED: "BOOKING_AGENT_EXTRACTION_FAILED",
  BOOKING_AGENT_RESPONSE_FAILED: "BOOKING_AGENT_RESPONSE_FAILED",
  BOOKING_AGENT_EXECUTION_FAILED: "BOOKING_AGENT_EXECUTION_FAILED",
  BOOKING_AGENT_STATE_PERSIST_FAILED: "BOOKING_AGENT_STATE_PERSIST_FAILED",
  BOOKING_AGENT_STATE_LOAD_FAILED: "BOOKING_AGENT_STATE_LOAD_FAILED",
  BOOKING_AGENT_STATE_CLEAR_FAILED: "BOOKING_AGENT_STATE_CLEAR_FAILED",
} as const;

export class BookingAgentException extends AppException {}

export class BookingAgentExtractionFailedException extends BookingAgentException {
  constructor(conversationId: string) {
    super(
      BookingAgentErrorCode.BOOKING_AGENT_EXTRACTION_FAILED,
      `Failed to extract intent from message for conversation ${conversationId}`,
      HttpStatus.INTERNAL_SERVER_ERROR,
      {
        title: "BookingAgent Extraction Failed",
        details: { conversationId },
      },
    );
  }
}

export class BookingAgentResponseFailedException extends BookingAgentException {
  constructor(conversationId: string) {
    super(
      BookingAgentErrorCode.BOOKING_AGENT_RESPONSE_FAILED,
      `Failed to generate response for conversation ${conversationId}`,
      HttpStatus.INTERNAL_SERVER_ERROR,
      {
        title: "BookingAgent Response Failed",
        details: { conversationId },
      },
    );
  }
}

export class BookingAgentExecutionFailedException extends BookingAgentException {
  constructor(conversationId: string, action: string) {
    super(
      BookingAgentErrorCode.BOOKING_AGENT_EXECUTION_FAILED,
      `Booking-agent turn failed at action "${action}" for conversation ${conversationId}`,
      HttpStatus.INTERNAL_SERVER_ERROR,
      {
        title: "Booking Agent Execution Failed",
        details: { conversationId, action },
      },
    );
  }
}

export class BookingAgentStatePersistFailedException extends BookingAgentException {
  constructor(conversationId: string, attempts: number) {
    super(
      BookingAgentErrorCode.BOOKING_AGENT_STATE_PERSIST_FAILED,
      `Failed to persist state for conversation ${conversationId} after ${attempts} attempts`,
      HttpStatus.SERVICE_UNAVAILABLE,
      {
        title: "BookingAgent State Persist Failed",
        details: { conversationId, attempts },
      },
    );
  }
}

export class BookingAgentStateLoadFailedException extends BookingAgentException {
  constructor(conversationId: string) {
    super(
      BookingAgentErrorCode.BOOKING_AGENT_STATE_LOAD_FAILED,
      `Failed to load state for conversation ${conversationId}`,
      HttpStatus.INTERNAL_SERVER_ERROR,
      {
        title: "BookingAgent State Load Failed",
        details: { conversationId },
      },
    );
  }
}

export class BookingAgentStateClearFailedException extends BookingAgentException {
  constructor(conversationId: string) {
    super(
      BookingAgentErrorCode.BOOKING_AGENT_STATE_CLEAR_FAILED,
      `Failed to clear state for conversation ${conversationId}`,
      HttpStatus.SERVICE_UNAVAILABLE,
      {
        title: "BookingAgent State Clear Failed",
        details: { conversationId },
      },
    );
  }
}
