import { describe, expect, it } from "vitest";
import { buildExtractorSystemPrompt } from "./extractor.prompt";

describe("extractor.prompt contract", () => {
  it("documents vehicleType ANY for long-tail no-preference extraction", () => {
    const prompt = buildExtractorSystemPrompt({
      currentDraft: { bookingType: "DAY", pickupDate: "2026-03-01" },
      lastShownOptions: [],
      stage: "collecting",
      messages: [],
    });

    expect(prompt).toContain('vehicleType: "ANY"');
    expect(prompt).toContain("no preference");
  });
});
