import { Injectable } from "@nestjs/common";
import { WhatsAppMessageKind } from "@prisma/client";
import type { InboundMessageContext, OrchestratorResult } from "./whatsapp-agent.interface";
import { WhatsAppWindowPolicyService } from "./whatsapp-window-policy.service";

@Injectable()
export class WhatsAppOrchestratorService {
  constructor(private readonly windowPolicyService: WhatsAppWindowPolicyService) {}

  /**
   * MVP baseline:
   * - route explicit handoff requests immediately
   * - keep all other intents in deterministic no-op mode until booking flows are wired
   */
  decide(
    context: InboundMessageContext & {
      windowExpiresAt?: Date | null;
    },
  ): OrchestratorResult {
    const body = context.body?.trim().toUpperCase() ?? "";
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

    // No outbound side-effect yet for regular text while booking flow wiring is in progress.
    return { enqueueOutbox: [] };
  }
}
