import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ExtractedAiSearchParams } from "../ai-search/ai-search.interface";
import type { WhatsAppOpenAiClient } from "./whatsapp-agent.tokens";
import { WHATSAPP_OPENAI_CLIENT } from "./whatsapp-agent.tokens";

interface FollowupQuestionContext {
  customerMessage?: string;
  extracted: ExtractedAiSearchParams;
  fallbackQuestion: string;
  missingFields: string[];
  intent: "precondition" | "booking_clarification";
}

@Injectable()
export class WhatsAppFollowupQuestionService {
  private readonly logger = new Logger(WhatsAppFollowupQuestionService.name);
  private readonly followupModel = "gpt-4o-mini";

  constructor(
    @Inject(WHATSAPP_OPENAI_CLIENT) private readonly openAiClient: WhatsAppOpenAiClient,
  ) {}

  async buildFriendlyQuestion(context: FollowupQuestionContext): Promise<string> {
    try {
      const completion = await this.openAiClient.chat.completions.create({
        model: this.followupModel,
        temperature: 0.2,
        max_tokens: 120,
        messages: [
          {
            role: "system",
            content: this.buildSystemPrompt(),
          },
          {
            role: "user",
            content: JSON.stringify({
              intent: context.intent,
              missingFields: context.missingFields,
              extracted: context.extracted,
              customerMessage: context.customerMessage ?? null,
              fallbackQuestion: context.fallbackQuestion,
            }),
          },
        ],
      });

      const response = completion.choices[0]?.message?.content?.trim();
      if (!response) {
        return context.fallbackQuestion;
      }

      return this.validateResponse(response, context.fallbackQuestion);
    } catch (error) {
      this.logger.warn("Failed to generate friendly follow-up question", {
        error: error instanceof Error ? error.message : String(error),
      });
      return context.fallbackQuestion;
    }
  }

  private validateResponse(response: string, fallback: string): string {
    if (response.length < 8 || response.length > 400) {
      return fallback;
    }
    // Guardrail: keep one concise question-like response.
    if (!/[?.]$/.test(response)) {
      return `${response}?`;
    }
    return response;
  }

  private buildSystemPrompt(): string {
    return `You are Tripdly's WhatsApp booking assistant.
Rewrite follow-up questions to sound friendly and concise.

Rules:
- Ask ONLY for the provided missing fields; do not introduce new requirements.
- Keep the same business meaning as fallbackQuestion.
- One short message, max 2 sentences.
- Keep tone warm and professional.
- Do not mention internal systems, tools, or "JSON".
- Output plain text only.`;
  }
}
