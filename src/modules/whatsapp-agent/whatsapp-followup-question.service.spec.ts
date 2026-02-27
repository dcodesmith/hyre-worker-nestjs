import { Test, TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WHATSAPP_OPENAI_CLIENT } from "./whatsapp-agent.tokens";
import { WhatsAppFollowupQuestionService } from "./whatsapp-followup-question.service";

describe("WhatsAppFollowupQuestionService", () => {
  let moduleRef: TestingModule;
  let service: WhatsAppFollowupQuestionService;
  let openAiClient: {
    chat: {
      completions: {
        create: ReturnType<typeof vi.fn>;
      };
    };
  };

  beforeEach(async () => {
    openAiClient = {
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    };

    moduleRef = await Test.createTestingModule({
      providers: [
        WhatsAppFollowupQuestionService,
        {
          provide: WHATSAPP_OPENAI_CLIENT,
          useValue: openAiClient,
        },
      ],
    }).compile();

    service = moduleRef.get(WhatsAppFollowupQuestionService);
  });

  it("falls back when model response is empty", async () => {
    openAiClient.chat.completions.create.mockResolvedValue({
      choices: [{ message: { content: "" } }],
    });

    const fallback = "Please share pickup date.";
    const result = await service.buildFriendlyQuestion({
      intent: "precondition",
      extracted: {},
      missingFields: ["from"],
      fallbackQuestion: fallback,
    });

    expect(result).toBe(fallback);
    expect(openAiClient.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-4o-mini",
        temperature: 0.2,
        max_tokens: 120,
      }),
    );
  });

  it("falls back when model call throws", async () => {
    openAiClient.chat.completions.create.mockRejectedValue(new Error("timeout"));

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
    openAiClient.chat.completions.create.mockResolvedValue({
      choices: [{ message: { content: "Could you share your pickup date" } }],
    });

    const result = await service.buildFriendlyQuestion({
      intent: "precondition",
      extracted: {},
      missingFields: ["from"],
      fallbackQuestion: "Please share pickup date.",
    });

    expect(result).toBe("Could you share your pickup date?");
  });

  it("keeps a trailing period when response already has punctuation", async () => {
    openAiClient.chat.completions.create.mockResolvedValue({
      choices: [{ message: { content: "Could you share your pickup date." } }],
    });

    const result = await service.buildFriendlyQuestion({
      intent: "precondition",
      extracted: {},
      missingFields: ["from"],
      fallbackQuestion: "Please share pickup date.",
    });

    expect(result).toBe("Could you share your pickup date.");
  });

  it("falls back when model response is shorter than guardrail minimum", async () => {
    openAiClient.chat.completions.create.mockResolvedValue({
      choices: [{ message: { content: "short" } }],
    });

    const fallback = "Please share pickup date.";
    const result = await service.buildFriendlyQuestion({
      intent: "precondition",
      extracted: {},
      missingFields: ["from"],
      fallbackQuestion: fallback,
    });

    expect(result).toBe(fallback);
  });

  it("falls back when model response exceeds guardrail maximum", async () => {
    openAiClient.chat.completions.create.mockResolvedValue({
      choices: [{ message: { content: "a".repeat(401) } }],
    });

    const fallback = "Please share pickup date.";
    const result = await service.buildFriendlyQuestion({
      intent: "precondition",
      extracted: {},
      missingFields: ["from"],
      fallbackQuestion: fallback,
    });

    expect(result).toBe(fallback);
  });
});
