import { Inject, Injectable } from "@nestjs/common";
import { OPENAI_SDK_CLIENT, type OpenAiSdkClient } from "../openai-sdk/openai-sdk.tokens";
import {
  AiSearchException,
  AiSearchProviderAuthenticationException,
  AiSearchProviderResponseInvalidException,
  AiSearchTimeoutException,
} from "./ai-search.error";
import type { ExtractedAiSearchParams } from "./ai-search.interface";
import { extractedAiSearchParamsSchema } from "./dto/ai-search.dto";

@Injectable()
export class OpenAiAiSearchExtractorService {
  private readonly openAiClient: OpenAiSdkClient;
  private static readonly LAGOS_TIMEZONE = "Africa/Lagos";

  constructor(@Inject(OPENAI_SDK_CLIENT) openAiClient: OpenAiSdkClient) {
    this.openAiClient = openAiClient.withOptions({
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

      if (
        error instanceof Error &&
        /missing bearer|basic authentication|incorrect api key|unauthorized/i.test(error.message)
      ) {
        throw new AiSearchProviderAuthenticationException();
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
- pickupLocation: Pickup location/address/landmark
- dropoffLocation: Drop-off location/address/landmark
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
- "night", "overnight" → NIGHT
- "24 hours", "full day", "24hr" → FULL_DAY
- "airport", "flight", "terminal", "arrivals" → AIRPORT_PICKUP

Important:
- Only include fields that are explicitly mentioned or can be inferred
- If duration is mentioned (e.g., "5 days"), calculate the end date
- Be flexible with synonyms (e.g., "Benz" = "Mercedes")
- Do not infer AIRPORT_PICKUP from generic "pick up"/"pickup"; only infer it when airport/flight context is present
- If user says "pick up and drop off at <same place>", set both pickupLocation and dropoffLocation to that place
- Return strict JSON only with these keys: color, make, model, vehicleType, serviceTier, from, to, bookingType, pickupTime, pickupLocation, dropoffLocation, flightNumber
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
