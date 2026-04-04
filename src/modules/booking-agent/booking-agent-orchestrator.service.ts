import { Injectable, Logger } from "@nestjs/common";
import { WhatsAppMessageKind } from "@prisma/client";
import type { InboundMessageContext, OrchestratorResult } from "./booking-agent.interface";
import { BookingAgentWindowPolicyService } from "./booking-agent-window-policy.service";
import { LangGraphGraphService } from "./langgraph/langgraph-graph.service";
import { LangGraphStateService } from "./langgraph/langgraph-state.service";

const LANGGRAPH_ERROR_FALLBACK_TEXT =
  "I'm having trouble processing your request. Please try again or type AGENT to speak with someone.";

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
          this.buildSingleOutboxReply(context, {
            dedupeKey: `handoff-ack:${context.messageId}`,
            textBody:
              "A Tripdly agent will join this chat shortly. Please share your booking reference if available.",
            templateName: "handoff-reopen",
          }),
        ],
        markAsHandoff: { reason: "USER_REQUESTED_AGENT" },
      };
    }

    if (body === "RESET" || body === "START OVER") {
      await this.langGraphStateService.clearState(context.conversationId);
      return {
        enqueueOutbox: [
          this.buildSingleOutboxReply(context, {
            dedupeKey: `reset-ack:${context.messageId}`,
            textBody:
              "Done - I have reset your current booking details. Please share your new request.",
            templateName: "booking-reopen",
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
            templateName: "booking-reopen",
          }),
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
    const { conversationId, messageId, body = "", customerId = null, interactive } = context;
    try {
      const result = await this.langGraphService.invoke({
        conversationId,
        messageId,
        message: body ?? "",
        customerId,
        interactive,
      });

      if (result.error) {
        this.logger.error("LangGraph execution returned error", {
          conversationId: context.conversationId,
          error: result.error,
        });
      }

      const outboxItems: OrchestratorResult["enqueueOutbox"] = result.outboxItems.map(
        ({ interactive, ...outboxItem }) => outboxItem,
      );

      if (result.error && outboxItems.length === 0) {
        outboxItems.push(
          this.buildSingleOutboxReply(context, {
            dedupeKey: `langgraph-error-fallback:${context.messageId}`,
            textBody: LANGGRAPH_ERROR_FALLBACK_TEXT,
          }),
        );
      }

      const hasHandoffOutbox = outboxItems.some((item) =>
        item.dedupeKey.startsWith("langgraph:handoff:"),
      );

      return {
        enqueueOutbox: outboxItems,
        resultingStage: result.stage,
        ...(hasHandoffOutbox ? { markAsHandoff: { reason: "USER_REQUESTED_AGENT" } } : {}),
      };
    } catch (error) {
      this.logger.error("LangGraph orchestration failed, falling back to error response", {
        conversationId: context.conversationId,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        enqueueOutbox: [
          this.buildSingleOutboxReply(context, {
            dedupeKey: `langgraph-error:${context.messageId}`,
            textBody: LANGGRAPH_ERROR_FALLBACK_TEXT,
            templateName: "booking-reopen",
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
      templateName?: string;
    },
  ): OrchestratorResult["enqueueOutbox"][number] {
    return {
      conversationId: context.conversationId,
      dedupeKey: input.dedupeKey,
      mode: this.windowPolicyService.resolveOutboundMode(context.windowExpiresAt),
      textBody: input.textBody,
      templateName: input.templateName,
      templateVariables: undefined,
    };
  }
}
