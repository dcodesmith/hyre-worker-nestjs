import { Test, type TestingModule } from "@nestjs/testing";
import { APIConnectionTimeoutError, AuthenticationError } from "openai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OPENAI_SDK_CLIENT } from "../openai-sdk/openai-sdk.tokens";
import {
  AiSearchProviderAuthenticationException,
  AiSearchProviderResponseInvalidException,
  AiSearchTimeoutException,
} from "./ai-search.error";
import { OpenAiAiSearchExtractorService } from "./openai-ai-search-extractor.service";

describe("OpenAiAiSearchExtractorService", () => {
  let service: OpenAiAiSearchExtractorService;
  let create: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    create = vi.fn();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OpenAiAiSearchExtractorService,
        {
          provide: OPENAI_SDK_CLIENT,
          useValue: {
            withOptions: vi.fn().mockReturnValue({
              chat: {
                completions: {
                  create,
                },
              },
            }),
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
    create.mockResolvedValue({ choices: [{ message: { content: "" } }] });

    await expect(service.extract("find me a car")).rejects.toBeInstanceOf(
      AiSearchProviderResponseInvalidException,
    );
  });

  it("throws timeout error on timeout", async () => {
    create.mockRejectedValue(new APIConnectionTimeoutError({ message: "Request timed out" }));

    await expect(service.extract("find me a car")).rejects.toBeInstanceOf(AiSearchTimeoutException);
  });

  it("throws auth error when provider reports authentication failure", async () => {
    create.mockRejectedValue(new AuthenticationError(401, undefined, "Invalid API key", undefined));

    await expect(service.extract("find me a car")).rejects.toBeInstanceOf(
      AiSearchProviderAuthenticationException,
    );
  });
});
