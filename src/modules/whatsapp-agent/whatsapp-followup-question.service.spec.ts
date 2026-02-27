import { ConfigService } from "@nestjs/config";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WhatsAppFollowupQuestionService } from "./whatsapp-followup-question.service";

describe("WhatsAppFollowupQuestionService", () => {
  let service: WhatsAppFollowupQuestionService;

  beforeEach(() => {
    const configService = {
      get: vi.fn().mockReturnValue("test-openai-api-key"),
    } as unknown as ConfigService;
    service = new WhatsAppFollowupQuestionService(configService);
  });

  it("falls back when model response is empty", async () => {
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: "" } }] });
    (service as unknown as { openAiClient: unknown }).openAiClient = {
      chat: { completions: { create } },
    };

    const fallback = "Please share pickup date.";
    const result = await service.buildFriendlyQuestion({
      intent: "precondition",
      extracted: {},
      missingFields: ["from"],
      fallbackQuestion: fallback,
    });

    expect(result).toBe(fallback);
  });

  it("falls back when model call throws", async () => {
    const create = vi.fn().mockRejectedValue(new Error("timeout"));
    (service as unknown as { openAiClient: unknown }).openAiClient = {
      chat: { completions: { create } },
    };

    const fallback = "Please share pickup and drop-off locations.";
    const result = await service.buildFriendlyQuestion({
      intent: "booking_clarification",
      extracted: {},
      missingFields: ["pickupLocation", "dropoffLocation"],
      fallbackQuestion: fallback,
    });

    expect(result).toBe(fallback);
  });

  it("appends a question mark when response lacks punctuation", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "Could you share your pickup date" } }],
    });
    (service as unknown as { openAiClient: unknown }).openAiClient = {
      chat: { completions: { create } },
    };

    const result = await service.buildFriendlyQuestion({
      intent: "precondition",
      extracted: {},
      missingFields: ["from"],
      fallbackQuestion: "Please share pickup date.",
    });

    expect(result).toBe("Could you share your pickup date?");
  });
});
