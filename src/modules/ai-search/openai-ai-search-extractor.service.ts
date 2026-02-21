import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import OpenAI from "openai";
import type { EnvConfig } from "../../config/env.config";
import {
  AiSearchException,
  AiSearchProviderResponseInvalidException,
  AiSearchTimeoutException,
} from "./ai-search.error";
import type { ExtractedAiSearchParams } from "./ai-search.interface";
import { extractedAiSearchParamsSchema } from "./dto/ai-search.dto";

@Injectable()
export class OpenAiAiSearchExtractorService {
  private readonly openAiClient: OpenAI;

  constructor(private readonly configService: ConfigService<EnvConfig>) {
    const apiKey = this.configService.get("OPENAI_API_KEY", { infer: true });
    this.openAiClient = new OpenAI({
      apiKey,
      timeout: 8000,
      maxRetries: 1,
    });
  }

  async extract(query: string): Promise<ExtractedAiSearchParams> {
    try {
      const completion = await this.openAiClient.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "Extract car search parameters from user query and return strict JSON keys only: color, make, model, vehicleType, serviceTier, from, to, bookingType, pickupTime, flightNumber. Do not include unknown keys.",
          },
          { role: "user", content: query },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: 300,
      });

      const content = completion.choices[0]?.message?.content;
      if (!content) {
        throw new AiSearchProviderResponseInvalidException();
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new AiSearchProviderResponseInvalidException();
      }

      const validated = extractedAiSearchParamsSchema.safeParse(parsed);
      if (!validated.success) {
        throw new AiSearchProviderResponseInvalidException();
      }

      return validated.data;
    } catch (error) {
      if (error instanceof AiSearchException) {
        throw error;
      }

      if (error instanceof Error && /timeout|timed out/i.test(error.message)) {
        throw new AiSearchTimeoutException();
      }

      throw new AiSearchProviderResponseInvalidException();
    }
  }
}
