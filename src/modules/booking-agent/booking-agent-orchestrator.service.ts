import { Injectable } from "@nestjs/common";
import { WhatsAppDeliveryMode, WhatsAppMessageKind } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import type { InboundMessageContext, OrchestratorResult } from "./booking-agent.interface";
import { BookingAgentWindowPolicyService } from "./booking-agent-window-policy.service";
import { BookingAgentStateService } from "./conversation/booking-agent-state.service";
import { BookingAgentTurnService } from "./conversation/booking-agent-turn.service";

const BOOKING_AGENT_ERROR_FALLBACK_TEXT =
  "I'm having trouble processing your request. Please try again or type AGENT to speak with someone.";

@Injectable()
export class BookingAgentOrchestratorService {
  constructor(
    private readonly windowPolicyService: BookingAgentWindowPolicyService,
    private readonly turnService: BookingAgentTurnService,
    private readonly bookingAgentStateService: BookingAgentStateService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(BookingAgentOrchestratorService.name);
  }

  /**
   * Main orchestration entry point.
   */
  async decide(
    context: InboundMessageContext & {
      windowExpiresAt?: Date | null;
    },
  ): Promise<OrchestratorResult> {
    const body = context.body?.trim().toUpperCase() ?? "";

    // Always handle explicit commands directly
    if (body === "AGENT") {
      return {
        enqueueOutbox: [
          this.buildSingleOutboxReply(context, {
            dedupeKey: `handoff-ack:${context.messageId}`,
            textBody:
              "A Tripdly agent will join this chat shortly. Please share your booking reference if available.",
          }),
        ],
        markAsHandoff: { reason: "USER_REQUESTED_AGENT" },
      };
    }

    if (body === "RESET" || body === "START OVER") {
      await this.bookingAgentStateService.clearState(context.conversationId);
      return {
        enqueueOutbox: [
          this.buildSingleOutboxReply(context, {
            dedupeKey: `reset-ack:${context.messageId}`,
            textBody:
              "Done - I have reset your current booking details. Please share your new request.",
          }),
        ],
      };
    }

    // Voice/media-specific fallback prompt for MVP until transcription/media flows are enabled.
    if (
      context.kind === WhatsAppMessageKind.AUDIO ||
      context.kind === WhatsAppMessageKind.DOCUMENT ||
      context.kind === WhatsAppMessageKind.IMAGE
    ) {
      return {
        enqueueOutbox: [
          this.buildSingleOutboxReply(context, {
            dedupeKey: `media-fallback:${context.messageId}`,
            textBody:
              "Thanks. For now, please send your pickup location, date/time, and booking type (DAY, NIGHT, or FULL_DAY) as text.",
          }),
        ],
      };
    }

    return this.decideTurn(context);
  }

  private async decideTurn(
    context: InboundMessageContext & { windowExpiresAt?: Date | null },
  ): Promise<OrchestratorResult> {
    const { conversationId, messageId, body = "", customerId = null, interactive } = context;
    try {
      const result = await this.turnService.invoke({
        conversationId,
        messageId,
        message: body ?? "",
        customerId,
        interactive,
      });

      if (result.error) {
        this.logger.error(
          {
            conversationId: context.conversationId,
            error: result.error,
          },
          "Booking agent turn returned error",
        );
      }

      const outboxItems: OrchestratorResult["enqueueOutbox"] = result.outboxItems.map(
        ({ interactive, ...outboxItem }) => {
          const delivery = this.resolveOutboundDelivery(
            context.windowExpiresAt,
            outboxItem.templateName,
            outboxItem.dedupeKey,
          );
          return {
            ...outboxItem,
            mode: delivery.mode,
            templateName: delivery.templateName,
          };
        },
      );

      if (result.error && outboxItems.length === 0) {
        outboxItems.push(
          this.buildSingleOutboxReply(context, {
            dedupeKey: `booking-agent-error-fallback:${context.messageId}`,
            textBody: BOOKING_AGENT_ERROR_FALLBACK_TEXT,
          }),
        );
      }

      const hasHandoffOutbox = outboxItems.some((item) =>
        item.dedupeKey.startsWith("booking-agent:handoff:"),
      );

      return {
        enqueueOutbox: outboxItems,
        resultingStage: result.stage,
        ...(hasHandoffOutbox ? { markAsHandoff: { reason: "USER_REQUESTED_AGENT" } } : {}),
      };
    } catch (error) {
      this.logger.error(
        {
          conversationId: context.conversationId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Booking agent turn failed, falling back to error response",
      );

      return {
        enqueueOutbox: [
          this.buildSingleOutboxReply(context, {
            dedupeKey: `booking-agent-error:${context.messageId}`,
            textBody: BOOKING_AGENT_ERROR_FALLBACK_TEXT,
          }),
        ],
      };
    }
  }

  private buildSingleOutboxReply(
    context: InboundMessageContext & { windowExpiresAt?: Date | null },
    input: {
      dedupeKey: string;
      textBody: string;
    },
  ): OrchestratorResult["enqueueOutbox"][number] {
    const delivery = this.resolveOutboundDelivery(
      context.windowExpiresAt,
      undefined,
      input.dedupeKey,
    );
    return {
      conversationId: context.conversationId,
      dedupeKey: input.dedupeKey,
      mode: delivery.mode,
      textBody: input.textBody,
      templateName: delivery.templateName,
      templateVariables: undefined,
    };
  }

  /**
   * Never enqueue TEMPLATE without an HX Content SID — sender rejects that state.
   * Outside the free-form window with no SID, fall back to FREE_FORM (Twilio may still
   * reject) until a dedicated reopen template is configured.
   */
  private resolveOutboundDelivery(
    windowExpiresAt: Date | null | undefined,
    templateName: string | undefined,
    dedupeKey: string,
  ): { mode: WhatsAppDeliveryMode; templateName: string | undefined } {
    if (templateName?.startsWith("HX")) {
      return {
        mode: WhatsAppDeliveryMode.TEMPLATE,
        templateName,
      };
    }

    const windowMode = this.windowPolicyService.resolveOutboundMode(windowExpiresAt);
    if (windowMode === WhatsAppDeliveryMode.TEMPLATE) {
      this.logger.warn(
        {
          dedupeKey,
          strippedTemplateName: templateName,
        },
        "Closed WhatsApp window requires a template SID; falling back to FREE_FORM",
      );
    }

    return {
      mode: WhatsAppDeliveryMode.FREE_FORM,
      templateName: undefined,
    };
  }
}
