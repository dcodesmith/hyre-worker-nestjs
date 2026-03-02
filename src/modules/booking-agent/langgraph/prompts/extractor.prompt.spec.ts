import { describe, expect, it } from "vitest";
import { buildExtractorSystemPrompt } from "./extractor.prompt";

describe("extractor.prompt contract", () => {
  it("contains critical extraction instructions", () => {
    const prompt = buildExtractorSystemPrompt({
      currentDraft: { bookingType: "DAY", pickupLocation: "Victoria Island" },
      lastShownOptions: [],
      stage: "collecting",
      messages: [{ role: "user", content: "hello", timestamp: "2026-03-01T00:00:00Z" }],
    });

    expect(prompt).toContain("YOUR TASK:");
    expect(prompt).toContain("CURRENT STAGE:");
    expect(prompt).toContain("RECENT CONVERSATION HISTORY:");
    expect(prompt).toContain("RULES:");
    expect(prompt).toContain("NEVER assume dropoffLocation equals pickupLocation");
  });
});
