import { HttpStatus } from "@nestjs/common";
import { AppException } from "../../common/errors/app.exception";

export const WhatsAppAgentErrorCode = {
  WHATSAPP_TOOL_INPUT_INVALID: "WHATSAPP_TOOL_INPUT_INVALID",
  WHATSAPP_TOOL_NOT_ENABLED: "WHATSAPP_TOOL_NOT_ENABLED",
  WHATSAPP_TOOL_UNKNOWN: "WHATSAPP_TOOL_UNKNOWN",
  WHATSAPP_AGENT_JOB_TYPE_UNKNOWN: "WHATSAPP_AGENT_JOB_TYPE_UNKNOWN",
  WHATSAPP_AGENT_LOCK_ACQUIRE_FAILED: "WHATSAPP_AGENT_LOCK_ACQUIRE_FAILED",
  WHATSAPP_INBOUND_MESSAGE_ID_MISSING: "WHATSAPP_INBOUND_MESSAGE_ID_MISSING",
  WHATSAPP_OUTBOUND_OUTBOX_ID_MISSING: "WHATSAPP_OUTBOUND_OUTBOX_ID_MISSING",
  WHATSAPP_OUTBOUND_TEMPLATE_INVALID: "WHATSAPP_OUTBOUND_TEMPLATE_INVALID",
  WHATSAPP_OUTBOUND_MESSAGE_EMPTY: "WHATSAPP_OUTBOUND_MESSAGE_EMPTY",
  WHATSAPP_OPERATION_TIMEOUT: "WHATSAPP_OPERATION_TIMEOUT",
} as const;

export class WhatsAppAgentException extends AppException {}

export class WhatsAppToolInputValidationException extends WhatsAppAgentException {
  constructor(toolName: string, issues: string) {
    super(
      WhatsAppAgentErrorCode.WHATSAPP_TOOL_INPUT_INVALID,
      `Invalid input for ${toolName}: ${issues}`,
      HttpStatus.BAD_REQUEST,
      {
        title: "WhatsApp Tool Input Invalid",
        details: { toolName },
      },
    );
  }
}

export class WhatsAppToolNotEnabledException extends WhatsAppAgentException {
  constructor(toolName: string) {
    super(
      WhatsAppAgentErrorCode.WHATSAPP_TOOL_NOT_ENABLED,
      `Tool "${toolName}" is defined but not enabled in this phase.`,
      HttpStatus.BAD_REQUEST,
      {
        title: "WhatsApp Tool Not Enabled",
        details: { toolName },
      },
    );
  }
}

export class WhatsAppToolUnknownException extends WhatsAppAgentException {
  constructor(toolName: string) {
    super(
      WhatsAppAgentErrorCode.WHATSAPP_TOOL_UNKNOWN,
      `Unknown WhatsApp tool "${toolName}"`,
      HttpStatus.BAD_REQUEST,
      {
        title: "Unknown WhatsApp Tool",
        details: { toolName },
      },
    );
  }
}

export class WhatsAppAgentUnknownJobTypeException extends WhatsAppAgentException {
  constructor(jobName: string) {
    super(
      WhatsAppAgentErrorCode.WHATSAPP_AGENT_JOB_TYPE_UNKNOWN,
      `Unknown WhatsApp Agent job type: ${jobName}`,
      HttpStatus.INTERNAL_SERVER_ERROR,
      {
        title: "Unknown WhatsApp Agent Job Type",
        details: { jobName },
      },
    );
  }
}

export class WhatsAppProcessingLockAcquireFailedException extends WhatsAppAgentException {
  constructor(conversationId: string) {
    super(
      WhatsAppAgentErrorCode.WHATSAPP_AGENT_LOCK_ACQUIRE_FAILED,
      `Failed to acquire conversation lock for ${conversationId}`,
      HttpStatus.CONFLICT,
      {
        title: "WhatsApp Processing Lock Acquire Failed",
        details: { conversationId },
      },
    );
  }
}

export class WhatsAppInboundMessageIdMissingException extends WhatsAppAgentException {
  constructor() {
    super(
      WhatsAppAgentErrorCode.WHATSAPP_INBOUND_MESSAGE_ID_MISSING,
      "Inbound message creation did not return an id",
      HttpStatus.INTERNAL_SERVER_ERROR,
      {
        title: "WhatsApp Inbound Message Id Missing",
      },
    );
  }
}

export class WhatsAppOutboundOutboxIdMissingException extends WhatsAppAgentException {
  constructor() {
    super(
      WhatsAppAgentErrorCode.WHATSAPP_OUTBOUND_OUTBOX_ID_MISSING,
      "Outbound enqueue did not return outbox id",
      HttpStatus.INTERNAL_SERVER_ERROR,
      {
        title: "WhatsApp Outbound Outbox Id Missing",
      },
    );
  }
}

export class WhatsAppOutboundTemplateInvalidException extends WhatsAppAgentException {
  constructor() {
    super(
      WhatsAppAgentErrorCode.WHATSAPP_OUTBOUND_TEMPLATE_INVALID,
      "Invalid TEMPLATE: templateName must be a Twilio Content SID starting with 'HX'",
      HttpStatus.BAD_REQUEST,
      {
        title: "WhatsApp Outbound Template Invalid",
      },
    );
  }
}

export class WhatsAppOutboundMessageEmptyException extends WhatsAppAgentException {
  constructor(outboxId: string) {
    super(
      WhatsAppAgentErrorCode.WHATSAPP_OUTBOUND_MESSAGE_EMPTY,
      `Outbox ${outboxId} has neither textBody nor mediaUrl`,
      HttpStatus.BAD_REQUEST,
      {
        title: "WhatsApp Outbound Message Empty",
        details: { outboxId },
      },
    );
  }
}

export class WhatsAppOperationTimeoutException extends WhatsAppAgentException {
  constructor(operation: string, timeoutMs: number) {
    super(
      WhatsAppAgentErrorCode.WHATSAPP_OPERATION_TIMEOUT,
      `Timed out after ${timeoutMs}ms during ${operation}`,
      HttpStatus.GATEWAY_TIMEOUT,
      {
        title: "WhatsApp Operation Timeout",
        details: { operation, timeoutMs },
      },
    );
  }
}
