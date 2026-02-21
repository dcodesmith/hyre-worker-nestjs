export interface ExtractedAiSearchParams {
  color?: string;
  make?: string;
  model?: string;
  vehicleType?: "SEDAN" | "SUV" | "LUXURY_SEDAN" | "LUXURY_SUV" | "VAN" | "CROSSOVER";
  serviceTier?: "STANDARD" | "EXECUTIVE" | "LUXURY" | "ULTRA_LUXURY";
  from?: string;
  to?: string;
  bookingType?: "DAY" | "NIGHT" | "FULL_DAY" | "AIRPORT_PICKUP";
  pickupTime?: string;
  flightNumber?: string;
}

export interface AiSearchResponse {
  params: Record<string, string>;
  interpretation: string;
  raw: ExtractedAiSearchParams;
}
