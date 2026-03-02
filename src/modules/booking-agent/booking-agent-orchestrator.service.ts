import { Injectable, Logger } from "@nestjs/common";
import { WhatsAppMessageKind } from "@prisma/client";
import type { InboundMessageContext, OrchestratorResult } from "./booking-agent.interface";
import { BookingAgentWindowPolicyService } from "./booking-agent-window-policy.service";
import { LangGraphGraphService } from "./langgraph/langgraph-graph.service";
import { LangGraphStateService } from "./langgraph/langgraph-state.service";

@Injectable()
export class BookingAgentOrchestratorService {
  private readonly logger = new Logger(BookingAgentOrchestratorService.name);

  constructor(
    private readonly windowPolicyService: BookingAgentWindowPolicyService,
    private readonly langGraphService: LangGraphGraphService,
    private readonly langGraphStateService: LangGraphStateService,
  ) {}

  /**
   * Main orchestration entry point.
   * Uses LangGraph for all conversational booking flows.
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
          {
            conversationId: context.conversationId,
            dedupeKey: `handoff-ack:${context.messageId}`,
            mode: this.windowPolicyService.resolveOutboundMode(context.windowExpiresAt),
            textBody:
              "A Tripdly agent will join this chat shortly. Please share your booking reference if available.",
            templateName: "handoff-reopen",
          },
        ],
        markAsHandoff: { reason: "USER_REQUESTED_AGENT" },
      };
    }

    if (body === "RESET" || body === "START OVER") {
      await this.langGraphStateService.clearState(context.conversationId);
      return {
        enqueueOutbox: [
          {
            conversationId: context.conversationId,
            dedupeKey: `reset-ack:${context.messageId}`,
            mode: this.windowPolicyService.resolveOutboundMode(context.windowExpiresAt),
            textBody:
              "Done - I have reset your current booking details. Please share your new request.",
            templateName: "booking-reopen",
          },
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
          {
            conversationId: context.conversationId,
            dedupeKey: `media-fallback:${context.messageId}`,
            mode: this.windowPolicyService.resolveOutboundMode(context.windowExpiresAt),
            textBody:
              "Thanks. For now, please send your pickup location, date/time, and booking type (DAY, NIGHT, or FULL_DAY) as text.",
            templateName: "booking-reopen",
          },
        ],
      };
    }

    return this.decideLangGraph(context);
  }

  /**
   * LangGraph-based orchestration for natural conversation flow.
   */
  private async decideLangGraph(
    context: InboundMessageContext & { windowExpiresAt?: Date | null },
  ): Promise<OrchestratorResult> {
    try {
      const result = await this.langGraphService.invoke({
        conversationId: context.conversationId,
        messageId: context.messageId,
        message: context.body ?? "",
        customerId: null,
        interactive: context.interactive,
      });

      if (result.error) {
        this.logger.error("LangGraph execution returned error", {
          conversationId: context.conversationId,
          error: result.error,
        });
      }

      const outboxItems: OrchestratorResult["enqueueOutbox"] = result.outboxItems.map((item) => ({
        conversationId: item.conversationId,
        dedupeKey: item.dedupeKey,
        mode: item.mode,
        textBody: item.textBody,
        mediaUrl: item.mediaUrl,
        templateName: item.templateName,
        templateVariables: item.templateVariables,
      }));

      if (result.error && outboxItems.length === 0) {
        outboxItems.push({
          conversationId: context.conversationId,
          dedupeKey: `langgraph-error-fallback:${context.messageId}`,
          mode: this.windowPolicyService.resolveOutboundMode(context.windowExpiresAt),
          textBody:
            "I'm having trouble processing your request. Please try again or type AGENT to speak with someone.",
          templateName: undefined,
          templateVariables: undefined,
        });
      }

      return { enqueueOutbox: outboxItems };
    } catch (error) {
      this.logger.error("LangGraph orchestration failed, falling back to error response", {
        conversationId: context.conversationId,
        error: error instanceof Error ? error.message : String(error),
      });

      const mode = this.windowPolicyService.resolveOutboundMode(context.windowExpiresAt);
      return {
        enqueueOutbox: [
          {
            conversationId: context.conversationId,
            dedupeKey: `langgraph-error:${context.messageId}`,
            mode,
            textBody:
              "I'm having trouble processing your request. Please try again or type AGENT to speak with someone.",
            templateName: "booking-reopen",
          },
        ],
      };
    }
  }
}
