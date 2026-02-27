import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AiSearchProviderAuthenticationException,
  AiSearchProviderResponseInvalidException,
  AiSearchTimeoutException,
} from "./ai-search.error";
import { OpenAiAiSearchExtractorService } from "./openai-ai-search-extractor.service";

describe("OpenAiAiSearchExtractorService", () => {
  let service: OpenAiAiSearchExtractorService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OpenAiAiSearchExtractorService,
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn().mockReturnValue("test-openai-api-key"),
          },
        },
      ],
    }).compile();

    service = module.get<OpenAiAiSearchExtractorService>(OpenAiAiSearchExtractorService);
  });

  it("builds parity system prompt with timezone and mapping rules", () => {
    const prompt = (
      service as unknown as { buildSystemPrompt: (now: Date) => string }
    ).buildSystemPrompt(new Date("2026-03-01T12:00:00.000Z"));

    expect(prompt).toContain("Timezone: Africa/Lagos (WAT)");
    expect(prompt).toContain("Vehicle type mapping:");
    expect(prompt).toContain('"Benz" = "Mercedes"');
    expect(prompt).toContain("today");
    expect(prompt).toContain("tomorrow");
  });

  it("throws invalid response error when OpenAI returns empty content", async () => {
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: "" } }] });
    (service as unknown as { openAiClient: unknown }).openAiClient = {
      chat: { completions: { create } },
    };

    await expect(service.extract("find me a car")).rejects.toBeInstanceOf(
      AiSearchProviderResponseInvalidException,
    );
  });

  it("throws timeout error on timeout message", async () => {
    const create = vi.fn().mockRejectedValue(new Error("Request timed out"));
    (service as unknown as { openAiClient: unknown }).openAiClient = {
      chat: { completions: { create } },
    };

    await expect(service.extract("find me a car")).rejects.toBeInstanceOf(AiSearchTimeoutException);
  });

  it("throws auth error when provider reports missing authentication header", async () => {
    const create = vi
      .fn()
      .mockRejectedValue(new Error("Missing bearer or basic authentication in header"));
    (service as unknown as { openAiClient: unknown }).openAiClient = {
      chat: { completions: { create } },
    };

    await expect(service.extract("find me a car")).rejects.toBeInstanceOf(
      AiSearchProviderAuthenticationException,
    );
  });
});
