import { Injectable } from "@nestjs/common";
import { AiSearchException, AiSearchFailedException } from "./ai-search.error";
import type { AiSearchResponse, ExtractedAiSearchParams } from "./ai-search.interface";
import { OpenAiAiSearchExtractorService } from "./openai-ai-search-extractor.service";

@Injectable()
export class AiSearchService {
  constructor(private readonly extractorService: OpenAiAiSearchExtractorService) {}

  async search(query: string): Promise<AiSearchResponse> {
    try {
      const extracted = await this.extractorService.extract(query.trim());
      return {
        params: this.buildSearchParams(extracted),
        interpretation: this.generateInterpretation(extracted),
        raw: extracted,
      };
    } catch (error) {
      if (error instanceof AiSearchException) {
        throw error;
      }
      throw new AiSearchFailedException();
    }
  }

  private buildSearchParams(params: ExtractedAiSearchParams): Record<string, string> {
    const searchParams: Record<string, string> = {};

    if (params.color) searchParams.color = params.color;
    if (params.make) searchParams.make = params.make;
    if (params.model) searchParams.model = params.model;
    if (params.vehicleType) searchParams.vehicleType = params.vehicleType;
    if (params.serviceTier) searchParams.serviceTier = params.serviceTier;
    if (params.from) searchParams.from = params.from;
    if (params.to) searchParams.to = params.to;
    if (params.bookingType) searchParams.bookingType = params.bookingType;
    if (params.pickupTime) searchParams.pickupTime = params.pickupTime;
    if (params.flightNumber) searchParams.flightNumber = params.flightNumber;

    return searchParams;
  }

  private generateInterpretation(params: ExtractedAiSearchParams): string {
    const parts: string[] = [];

    if (params.color || params.make || params.vehicleType || params.serviceTier || params.model) {
      const vehicle = [
        params.color,
        params.make,
        params.model,
        params.serviceTier?.toLowerCase().replaceAll("_", " "),
        params.vehicleType?.toLowerCase().replaceAll("_", " "),
      ]
        .filter(Boolean)
        .join(" ");
      parts.push(`Looking for: ${vehicle}`);
    }

    if (params.from && params.to) {
      parts.push(`Dates: ${params.from} to ${params.to}`);
    } else if (params.from) {
      parts.push(`Starting: ${params.from}`);
    }

    if (params.bookingType) {
      const typeLabels = {
        DAY: "day rental",
        NIGHT: "night service",
        FULL_DAY: "full day (24hr)",
        AIRPORT_PICKUP: "airport pickup",
      } as const;
      parts.push(`Type: ${typeLabels[params.bookingType]}`);
    }

    return parts.join(" • ");
  }
}
