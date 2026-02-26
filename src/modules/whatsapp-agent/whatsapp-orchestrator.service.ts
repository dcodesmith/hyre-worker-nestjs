import { Injectable } from "@nestjs/common";
import { WhatsAppMessageKind } from "@prisma/client";
import type {
  InboundMessageContext,
  OrchestratorResult,
  VehicleSearchToolResult,
} from "./whatsapp-agent.interface";
import { WhatsAppToolExecutorService } from "./whatsapp-tool-executor.service";
import { WhatsAppWindowPolicyService } from "./whatsapp-window-policy.service";

@Injectable()
export class WhatsAppOrchestratorService {
  constructor(
    private readonly windowPolicyService: WhatsAppWindowPolicyService,
    private readonly toolExecutorService: WhatsAppToolExecutorService,
  ) {}

  /**
   * MVP baseline:
   * - route explicit handoff requests immediately
   * - keep all other intents in deterministic no-op mode until booking flows are wired
   */
  async decide(
    context: InboundMessageContext & {
      windowExpiresAt?: Date | null;
    },
  ): Promise<OrchestratorResult> {
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

    const mode = this.windowPolicyService.resolveOutboundMode(context.windowExpiresAt);
    const searchResult = await this.toolExecutorService.searchVehiclesFromMessage(
      context.body ?? "",
    );
    if (!searchResult) {
      return {
        enqueueOutbox: [
          {
            conversationId: context.conversationId,
            dedupeKey: `collect-details:${context.messageId}`,
            mode,
            textBody:
              "I can help you find a car. Share pickup date, drop-off date, booking type (DAY, NIGHT, FULL_DAY or AIRPORT_PICKUP), and any preference like SUV, color, or brand.",
            templateName: "booking-reopen",
          },
        ],
      };
    }

    if (searchResult.options.length === 0) {
      return {
        enqueueOutbox: [
          {
            conversationId: context.conversationId,
            dedupeKey: `no-options:${context.messageId}`,
            mode,
            textBody:
              "I could not find available cars for those details. Please try another date, booking type, or broader vehicle preferences.",
            templateName: "booking-reopen",
          },
        ],
      };
    }

    const outboxItems: OrchestratorResult["enqueueOutbox"] = [
      {
        conversationId: context.conversationId,
        dedupeKey: `options-list:${context.messageId}`,
        mode,
        textBody: this.buildVehicleOptionsMessage(searchResult),
      },
    ];

    searchResult.options.forEach((option, index) => {
      if (!option.imageUrl) {
        return;
      }

      outboxItems.push({
        conversationId: context.conversationId,
        dedupeKey: `option-image:${context.messageId}:${option.id}`,
        mode,
        textBody: `${index + 1}. ${option.name}`,
        mediaUrl: option.imageUrl,
      });
    });

    return { enqueueOutbox: outboxItems };
  }

  private buildVehicleOptionsMessage(result: VehicleSearchToolResult): string {
    const header = result.interpretation
      ? `Found options for: ${result.interpretation}`
      : "Here are available options:";

    const lines = result.options.map((option, index) => {
      const rateParts = [
        `DAY ₦${option.rates.day.toLocaleString()}`,
        option.rates.night == null ? null : `NIGHT ₦${option.rates.night.toLocaleString()}`,
        option.rates.fullDay == null ? null : `FULL_DAY ₦${option.rates.fullDay.toLocaleString()}`,
      ].filter(Boolean);

      const color = option.color ? ` (${option.color})` : "";
      return `${index + 1}. ${option.name}${color} — ${rateParts.join(" | ")}`;
    });

    return `${header}\n${lines.join("\n")}\nReply with the option number to continue.`;
  }
}
