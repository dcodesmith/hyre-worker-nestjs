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
  private static readonly LAGOS_TIMEZONE = "Africa/Lagos";

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
            content: this.buildSystemPrompt(),
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

  private buildSystemPrompt(now: Date = new Date()): string {
    const today = this.formatDateInTimezone(now, OpenAiAiSearchExtractorService.LAGOS_TIMEZONE);
    const tomorrow = this.formatDateInTimezone(
      new Date(now.getTime() + 24 * 60 * 60 * 1000),
      OpenAiAiSearchExtractorService.LAGOS_TIMEZONE,
    );

    return `You are a car rental search assistant for Tripdly in Lagos, Nigeria.
Extract search parameters from user queries and return them as JSON.

Today's date is: ${today} (${today})
Timezone: Africa/Lagos (WAT)

Extract the following fields when mentioned:
- color: Vehicle color (e.g., "black", "white", "silver", "blue", "red")
- make: Car brand (e.g., "Toyota", "Mercedes", "BMW", "Lexus")
- model: Car model (e.g., "Camry", "E-Class", "X5")
- vehicleType: One of: SEDAN, SUV, LUXURY_SEDAN, LUXURY_SUV, VAN, CROSSOVER
- serviceTier: One of: STANDARD, EXECUTIVE, LUXURY, ULTRA_LUXURY
- from: Start date in YYYY-MM-DD format
- to: End date in YYYY-MM-DD format
- bookingType: One of: DAY, NIGHT, FULL_DAY, AIRPORT_PICKUP
- pickupTime: Time in "HH AM/PM" format (e.g., "10 AM", "2 PM")
- flightNumber: Flight number for airport pickups

Date parsing rules:
- "today" = ${today}
- "tomorrow" = ${tomorrow}
- "next Monday/Tuesday/etc" = calculate the next occurrence
- "X days" = duration from start date
- "X nights" = duration + set bookingType to NIGHT

Vehicle type mapping:
- "sedan", "car", "saloon" → SEDAN
- "suv", "jeep" → SUV
- "luxury sedan", "premium sedan" → LUXURY_SEDAN
- "luxury suv", "premium suv" → LUXURY_SUV
- "van", "bus", "minibus" → VAN
- "crossover" → CROSSOVER

Service tier mapping:
- "standard", "budget", "cheap", "affordable" → STANDARD
- "executive", "business" → EXECUTIVE
- "luxury", "premium" → LUXURY
- "ultra luxury", "ultra-luxury", "high-end" → ULTRA_LUXURY

Booking type mapping:
- Default to DAY if dates are mentioned without specifying night/airport
- "night", "overnight" → NIGHT
- "24 hours", "full day", "24hr" → FULL_DAY
- "airport", "flight", "pickup" → AIRPORT_PICKUP

Important:
- Only include fields that are explicitly mentioned or can be inferred
- If duration is mentioned (e.g., "5 days"), calculate the end date
- Be flexible with synonyms (e.g., "Benz" = "Mercedes")
- Return strict JSON only with these keys: color, make, model, vehicleType, serviceTier, from, to, bookingType, pickupTime, flightNumber
- Do not include unknown keys or explanatory text`;
  }

  private formatDateInTimezone(date: Date, timezone: string): string {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });

    return formatter.format(date);
  }
}
