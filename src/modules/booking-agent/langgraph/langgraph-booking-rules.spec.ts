import { describe, expect, it } from "vitest";
import {
  applyDerivedDraftFields,
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

  it("auto-derives DAY dropoffDate using durationDays as leg count", () => {
    const draft = {
      bookingType: "DAY" as const,
      pickupDate: "2026-03-05",
      durationDays: 5,
      pickupLocation: "Lekki Phase 1",
      dropoffLocation: "Lekki Phase 1",
      pickupTime: "09:00",
    };

    const result = applyDerivedDraftFields(draft, "");
    expect(result.dropoffDate).toBe("2026-03-09");
  });

  it("auto-derives FULL_DAY dropoffDate using durationDays as leg count", () => {
    const draft = {
      bookingType: "FULL_DAY" as const,
      pickupDate: "2026-03-05",
      durationDays: 5,
      pickupLocation: "Lekki Phase 1",
      dropoffLocation: "Lekki Phase 1",
      pickupTime: "09:00",
    };

    const result = applyDerivedDraftFields(draft, "");
    expect(result.dropoffDate).toBe("2026-03-10");
  });

  it("normalizes conflicting dropoffDate from durationDays for non-NIGHT bookings", () => {
    const draft = {
      bookingType: "DAY" as const,
      pickupDate: "2026-04-05",
      durationDays: 5,
      dropoffDate: "2026-04-10",
      pickupLocation: "Lekki Phase 1",
      dropoffLocation: "Lekki Phase 1",
      pickupTime: "09:00",
    };

    const result = applyDerivedDraftFields(draft, "");
    expect(result.dropoffDate).toBe("2026-04-09");
  });

  it("normalizes conflicting dropoffDate from durationDays for FULL_DAY bookings", () => {
    const draft = {
      bookingType: "FULL_DAY" as const,
      pickupDate: "2026-04-05",
      durationDays: 5,
      dropoffDate: "2026-04-09",
      pickupLocation: "Lekki Phase 1",
      dropoffLocation: "Lekki Phase 1",
      pickupTime: "09:00",
    };

    const result = applyDerivedDraftFields(draft, "");
    expect(result.dropoffDate).toBe("2026-04-10");
  });

  it("detects draft changes across key fields", () => {
    const oldDraft = { pickupDate: "2026-03-01", bookingType: "DAY" as const };
    const newDraft = { pickupDate: "2026-03-02", bookingType: "DAY" as const };
    expect(hasDraftChanged(oldDraft, newDraft)).toBe(true);
  });

  it("applies draft patches only for data-updating intents", () => {
    expect(shouldApplyDraftPatch("provide_info")).toBe(true);
    expect(shouldApplyDraftPatch("confirm")).toBe(false);
    expect(shouldApplyDraftPatch("cancel")).toBe(false);
  });
});
