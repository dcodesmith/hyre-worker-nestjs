import { addDays, format } from "date-fns";
import { describe, expect, it } from "vitest";
import { buildExtractorSystemPrompt } from "./prompts/extractor.prompt";

describe("Airport Pickup Extraction Prompt", () => {
  const now = new Date();
  const tomorrowFormatted = format(addDays(now, 1), "yyyy-MM-dd");

  it("includes explicit airport pickup extraction rules", () => {
    const prompt = buildExtractorSystemPrompt({
      currentDraft: {},
      lastShownOptions: [],
      stage: "collecting",
      messages: [],
    });

    expect(prompt).toContain("AIRPORT PICKUP EXTRACTION");
    expect(prompt).toContain("flightNumber");
    expect(prompt).toContain("dropoffLocation");
    expect(prompt).toContain("DO NOT set pickupLocation for airport pickups");
    expect(prompt).toContain("DO NOT set pickupTime for airport pickups");
  });

  it("includes airport pickup examples with flight number and destination", () => {
    const prompt = buildExtractorSystemPrompt({
      currentDraft: {},
      lastShownOptions: [],
      stage: "collecting",
      messages: [],
    });

    expect(prompt).toContain('flightNumber: "BA75"');
    expect(prompt).toContain('dropoffLocation: "Mason Apartments, Ikoyi"');
  });

  it("includes tomorrow's date in airport pickup examples", () => {
    const prompt = buildExtractorSystemPrompt({
      currentDraft: {},
      lastShownOptions: [],
      stage: "collecting",
      messages: [],
    });

    expect(prompt).toContain(`pickupDate: "${tomorrowFormatted}"`);
  });
});
