import { describe, expect, it } from "vitest";
import { buildActiveWindowWhere, buildOverlapWindowWhere, isRateActive } from "./rates.helper";

describe("rates.helper", () => {
  const computeOverlapFlags = (
    existing: { effectiveSince: Date; effectiveUntil: Date | null },
    where: ReturnType<typeof buildOverlapWindowWhere>,
  ) => {
    const leftSide = existing.effectiveSince < where.effectiveSince.lt;
    const rightSide =
      (existing.effectiveUntil !== null &&
        existing.effectiveUntil >
          (where.OR[0] as { effectiveUntil: { gt: Date } }).effectiveUntil.gt) ||
      existing.effectiveUntil === null;

    return { leftSide, rightSide, overlaps: leftSide && rightSide };
  };

  describe("buildActiveWindowWhere", () => {
    it("builds active predicate with inclusive since and exclusive until", () => {
      const at = new Date("2026-03-01T00:00:00.000Z");
      const where = buildActiveWindowWhere(at);

      expect(where).toEqual({
        effectiveSince: { lte: at },
        OR: [{ effectiveUntil: { gt: at } }, { effectiveUntil: null }],
      });
    });
  });

  describe("buildOverlapWindowWhere", () => {
    it("builds overlap predicate with provided end date and lt/gt comparisons", () => {
      const since = new Date("2026-03-01T00:00:00.000Z");
      const until = new Date("2026-06-01T00:00:00.000Z");
      const where = buildOverlapWindowWhere(since, until);

      expect(where).toEqual({
        effectiveSince: { lt: until },
        OR: [{ effectiveUntil: { gt: since } }, { effectiveUntil: null }],
      });
    });

    it("uses far future date when effectiveUntil is undefined", () => {
      const since = new Date("2026-03-01T00:00:00.000Z");
      const where = buildOverlapWindowWhere(since);

      expect(where.effectiveSince).toEqual({ lt: new Date("9999-12-31T00:00:00.000Z") });
      expect(where.OR).toEqual([{ effectiveUntil: { gt: since } }, { effectiveUntil: null }]);
    });

    it("builds predicates that exclude adjacent non-overlapping windows", () => {
      const since = new Date("2026-03-01T00:00:00.000Z");
      const until = new Date("2026-06-01T00:00:00.000Z");
      const adjacentExisting = {
        effectiveSince: until,
        effectiveUntil: new Date("2026-09-01T00:00:00.000Z"),
      };
      const where = buildOverlapWindowWhere(since, until);
      const { leftSide, rightSide, overlaps } = computeOverlapFlags(adjacentExisting, where);

      expect(leftSide).toBe(false);
      expect(rightSide).toBe(true);
      expect(overlaps).toBe(false);
    });

    it("builds predicates that include truly overlapping windows", () => {
      const since = new Date("2026-03-01T00:00:00.000Z");
      const until = new Date("2026-06-01T00:00:00.000Z");
      const overlappingExisting = {
        effectiveSince: new Date("2026-05-15T00:00:00.000Z"),
        effectiveUntil: new Date("2026-07-01T00:00:00.000Z"),
      };
      const where = buildOverlapWindowWhere(since, until);
      const { leftSide, rightSide, overlaps } = computeOverlapFlags(overlappingExisting, where);

      expect(leftSide).toBe(true);
      expect(rightSide).toBe(true);
      expect(overlaps).toBe(true);
    });

    it("OR branch matches open-ended existing windows", () => {
      const since = new Date("2026-03-01T00:00:00.000Z");
      const where = buildOverlapWindowWhere(since, new Date("2026-06-01T00:00:00.000Z"));

      expect(where.OR[1]).toEqual({ effectiveUntil: null });
    });
  });

  describe("isRateActive", () => {
    it("treats rates starting exactly at query time as active", () => {
      const at = new Date("2026-03-01T00:00:00.000Z");
      const active = isRateActive({ effectiveSince: at, effectiveUntil: null }, at);

      expect(active).toBe(true);
    });

    it("treats rates ending exactly at query time as inactive", () => {
      const at = new Date("2026-03-01T00:00:00.000Z");
      const active = isRateActive(
        { effectiveSince: new Date("2026-02-01T00:00:00.000Z"), effectiveUntil: at },
        at,
      );

      expect(active).toBe(false);
    });

    it("treats open-ended rates as active for times after effectiveSince", () => {
      const since = new Date("2026-03-01T00:00:00.000Z");
      const at = new Date("2026-04-01T00:00:00.000Z");
      const active = isRateActive({ effectiveSince: since, effectiveUntil: null }, at);

      expect(active).toBe(true);
    });
  });
});
