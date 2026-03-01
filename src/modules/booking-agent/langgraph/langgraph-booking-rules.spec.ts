import { describe, expect, it } from "vitest";
import {
  applyDerivedDraftFields,
  getMissingRequiredFields,
  hasDraftChanged,
  shouldApplyDraftPatch,
} from "./langgraph-booking-rules";

describe("langgraph-booking-rules", () => {
  it("applies same-location fallback when explicitly requested", () => {
    const draft = {
      pickupLocation: "5 Glover Road, Ikoyi",
      bookingType: "DAY" as const,
      pickupDate: "2026-03-01",
      pickupTime: "09:00",
      dropoffDate: "2026-03-01",
    };

    const result = applyDerivedDraftFields(draft, "drop me off at the same place");
    expect(result.dropoffLocation).toBe("5 Glover Road, Ikoyi");
  });

  it("auto-derives NIGHT pickupTime and dropoffDate", () => {
    const draft = {
      bookingType: "NIGHT" as const,
      pickupDate: "2026-03-05",
      durationDays: 2,
      pickupLocation: "Lekki Phase 1",
      dropoffLocation: "Lekki Phase 1",
    };

    const result = applyDerivedDraftFields(draft, "");
    expect(result.pickupTime).toBe("23:00");
    expect(result.dropoffDate).toBe("2026-03-07");
  });

  it("detects draft changes across key fields", () => {
    const oldDraft = { pickupDate: "2026-03-01", bookingType: "DAY" as const };
    const newDraft = { pickupDate: "2026-03-02", bookingType: "DAY" as const };
    expect(hasDraftChanged(oldDraft, newDraft)).toBe(true);
  });

  it("returns missing required fields", () => {
    const missing = getMissingRequiredFields({
      bookingType: "DAY",
      pickupDate: "2026-03-01",
      pickupTime: "09:00",
    });
    expect(missing).toContain("pickupLocation");
    expect(missing).toContain("dropoffDate");
    expect(missing).toContain("dropoffLocation");
  });

  it("applies draft patches only for data-updating intents", () => {
    expect(shouldApplyDraftPatch("provide_info")).toBe(true);
    expect(shouldApplyDraftPatch("confirm")).toBe(false);
    expect(shouldApplyDraftPatch("cancel")).toBe(false);
  });
});
