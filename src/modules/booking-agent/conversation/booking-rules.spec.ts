import { describe, expect, it } from "vitest";
import {
  applyDerivedDraftFields,
  getDurationUnitClarification,
  hasDraftChanged,
  shouldApplyDraftPatch,
} from "./booking-rules";

describe("booking-agent-booking-rules", () => {
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

  it("replaces an extracted same-location phrase with the pickup address", () => {
    const result = applyDerivedDraftFields(
      {
        pickupLocation: "Mason Apartments, Ikoyi",
        dropoffLocation: "Same as pickup location",
      },
      "9am\nMason Apartments, Ikoyi\nSame as pickup location",
    );

    expect(result.dropoffLocation).toBe("Mason Apartments, Ikoyi");
  });

  it("detects conflicting booking type and duration units", () => {
    expect(getDurationUnitClarification("Day booking from tomorrow for 2 nights", "DAY")).toBe(
      "You mentioned a Day booking for 2 nights. Do you want a Day booking for 2 days, or a Night booking for 2 nights?",
    );
    expect(getDurationUnitClarification("Day booking for 2 days, actually 3 nights", "DAY")).toBe(
      "You mentioned a Day booking for 3 nights. Do you want a Day booking for 3 days, or a Night booking for 3 nights?",
    );
    expect(getDurationUnitClarification("Night booking for 2 nights", "NIGHT")).toBeNull();
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

  it("preserves explicit NIGHT dropoffDate when durationDays is missing", () => {
    const draft = {
      bookingType: "NIGHT" as const,
      pickupDate: "2026-04-05",
      dropoffDate: "2026-04-08",
      pickupLocation: "Lekki Phase 1",
      dropoffLocation: "Lekki Phase 1",
    };

    const result = applyDerivedDraftFields(draft, "");
    expect(result.pickupTime).toBe("23:00");
    expect(result.dropoffDate).toBe("2026-04-08");
  });

  it("detects draft changes across key fields", () => {
    const oldDraft = { pickupDate: "2026-03-01", bookingType: "DAY" as const };
    const newDraft = { pickupDate: "2026-03-02", bookingType: "DAY" as const };
    expect(hasDraftChanged(oldDraft, newDraft)).toBe(true);
  });

  it("treats pickupTime and dropoffLocation as draft changes", () => {
    const oldDraft = {
      pickupDate: "2026-03-01",
      pickupTime: "09:00",
      dropoffLocation: "Ikoyi",
      bookingType: "DAY" as const,
    };

    expect(hasDraftChanged(oldDraft, { ...oldDraft, pickupTime: "10:00" })).toBe(true);
    expect(hasDraftChanged(oldDraft, { ...oldDraft, dropoffLocation: "Lekki" })).toBe(true);
    expect(hasDraftChanged(oldDraft, { ...oldDraft, flightNumber: "P4 123" })).toBe(true);
    expect(hasDraftChanged(oldDraft, { ...oldDraft, notes: "Gate 4 pickup" })).toBe(false);
    expect(hasDraftChanged(oldDraft, oldDraft)).toBe(false);
  });

  it("applies draft patches only for data-updating intents", () => {
    expect(shouldApplyDraftPatch("provide_info")).toBe(true);
    expect(shouldApplyDraftPatch("confirm")).toBe(false);
    expect(shouldApplyDraftPatch("cancel")).toBe(false);
  });
});
