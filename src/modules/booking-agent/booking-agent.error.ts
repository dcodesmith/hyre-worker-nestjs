import { HttpStatus } from "@nestjs/common";
import { AppException } from "../../common/errors/app.exception";

export const BookingAgentErrorCode = {
  WHATSAPP_AGENT_JOB_TYPE_UNKNOWN: "WHATSAPP_AGENT_JOB_TYPE_UNKNOWN",
  WHATSAPP_AGENT_LOCK_ACQUIRE_FAILED: "WHATSAPP_AGENT_LOCK_ACQUIRE_FAILED",
  WHATSAPP_INBOUND_MESSAGE_ID_MISSING: "WHATSAPP_INBOUND_MESSAGE_ID_MISSING",
  WHATSAPP_OUTBOUND_OUTBOX_ID_MISSING: "WHATSAPP_OUTBOUND_OUTBOX_ID_MISSING",
  WHATSAPP_OUTBOUND_TEMPLATE_INVALID: "WHATSAPP_OUTBOUND_TEMPLATE_INVALID",
  WHATSAPP_OUTBOUND_MESSAGE_EMPTY: "WHATSAPP_OUTBOUND_MESSAGE_EMPTY",
  WHATSAPP_OPERATION_TIMEOUT: "WHATSAPP_OPERATION_TIMEOUT",
} as const;

export class BookingAgentException extends AppException {}

export class WhatsAppAgentUnknownJobTypeException extends BookingAgentException {
  constructor(jobName: string) {
    super(
      BookingAgentErrorCode.WHATSAPP_AGENT_JOB_TYPE_UNKNOWN,
      `Unknown WhatsApp Agent job type: ${jobName}`,
      HttpStatus.INTERNAL_SERVER_ERROR,
      {
        title: "Unknown WhatsApp Agent Job Type",
        details: { jobName },
      },
    );
  }
}

export class WhatsAppProcessingLockAcquireFailedException extends BookingAgentException {
  constructor(conversationId: string) {
    super(
      BookingAgentErrorCode.WHATSAPP_AGENT_LOCK_ACQUIRE_FAILED,
      `Failed to acquire conversation lock for ${conversationId}`,
      HttpStatus.CONFLICT,
      {
        title: "WhatsApp Processing Lock Acquire Failed",
        details: { conversationId },
      },
    );
  }
}

export class WhatsAppInboundMessageIdMissingException extends BookingAgentException {
  constructor() {
    super(
      BookingAgentErrorCode.WHATSAPP_INBOUND_MESSAGE_ID_MISSING,
      "Inbound message creation did not return an id",
      HttpStatus.INTERNAL_SERVER_ERROR,
      {
        title: "WhatsApp Inbound Message Id Missing",
      },
    );
  }
}

export class WhatsAppOutboundOutboxIdMissingException extends BookingAgentException {
  constructor() {
    super(
      BookingAgentErrorCode.WHATSAPP_OUTBOUND_OUTBOX_ID_MISSING,
      "Outbound enqueue did not return outbox id",
      HttpStatus.INTERNAL_SERVER_ERROR,
      {
        title: "WhatsApp Outbound Outbox Id Missing",
      },
    );
  }
}

export class WhatsAppOutboundTemplateInvalidException extends BookingAgentException {
  constructor() {
    super(
      BookingAgentErrorCode.WHATSAPP_OUTBOUND_TEMPLATE_INVALID,
      "Invalid TEMPLATE: templateName must be a Twilio Content SID starting with 'HX'",
      HttpStatus.BAD_REQUEST,
      {
        title: "WhatsApp Outbound Template Invalid",
      },
    );
  }
}

export class WhatsAppOutboundMessageEmptyException extends BookingAgentException {
  constructor(outboxId: string) {
    super(
      BookingAgentErrorCode.WHATSAPP_OUTBOUND_MESSAGE_EMPTY,
      `Outbox ${outboxId} has neither textBody nor mediaUrl`,
      HttpStatus.BAD_REQUEST,
      {
        title: "WhatsApp Outbound Message Empty",
        details: { outboxId },
      },
    );
  }
}

export class WhatsAppOperationTimeoutException extends BookingAgentException {
  constructor(operation: string, timeoutMs: number) {
    super(
      BookingAgentErrorCode.WHATSAPP_OPERATION_TIMEOUT,
      `Timed out after ${timeoutMs}ms during ${operation}`,
      HttpStatus.GATEWAY_TIMEOUT,
      {
        title: "WhatsApp Operation Timeout",
        details: { operation, timeoutMs },
      },
    );
  }
}
