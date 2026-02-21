import { describe, expect, it } from "vitest";
import { extractedAiSearchParamsSchema } from "./ai-search.dto";

describe("extractedAiSearchParamsSchema", () => {
  it("accepts valid ISO date range", () => {
    const parsed = extractedAiSearchParamsSchema.safeParse({
      make: "Toyota",
      from: "2026-03-01",
      to: "2026-03-05",
      bookingType: "DAY",
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects non-ISO dates", () => {
    const parsed = extractedAiSearchParamsSchema.safeParse({
      from: "03/01/2026",
      to: "2026-03-05",
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects end date before start date", () => {
    const parsed = extractedAiSearchParamsSchema.safeParse({
      from: "2026-03-05",
      to: "2026-03-01",
    });

    expect(parsed.success).toBe(false);
  });
});
