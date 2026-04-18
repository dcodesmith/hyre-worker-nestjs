import { describe, expect, it } from "vitest";
import type { PromotionLegSummaryInput } from "./promotion.interface";
import { summarizePromotionPricingLegs } from "./promotion-pricing-preview";

function standardLeg(basePrice: number): PromotionLegSummaryInput {
  return { basePrice, finalPrice: basePrice, promotion: null };
}

function promoLeg(input: {
  id: string;
  basePrice: number;
  finalPrice: number;
  discountValue: number;
  name?: string | null;
}): PromotionLegSummaryInput {
  return {
    basePrice: input.basePrice,
    finalPrice: input.finalPrice,
    promotion: {
      id: input.id,
      discountValue: input.discountValue,
      name: input.name ?? null,
    },
  };
}

describe("summarizePromotionPricingLegs", () => {
  it("returns an empty preview when given no legs", () => {
    const preview = summarizePromotionPricingLegs([]);

    expect(preview).toEqual({
      baseTotal: 0,
      compareAtBaseTotal: 0,
      discountCoverage: "NONE",
      segments: [],
    });
  });

  it("returns NONE coverage for all-standard legs and merges identical-price rows", () => {
    const preview = summarizePromotionPricingLegs([
      standardLeg(50_000),
      standardLeg(50_000),
      standardLeg(50_000),
    ]);

    expect(preview.discountCoverage).toBe("NONE");
    expect(preview.compareAtBaseTotal).toBe(150_000);
    expect(preview.baseTotal).toBe(150_000);
    expect(preview.segments).toHaveLength(1);
    expect(preview.segments[0]).toMatchObject({
      kind: "STANDARD",
      units: 3,
      unitPrice: 50_000,
      total: 150_000,
      compareAtUnitPrice: null,
      label: null,
    });
  });

  it("returns FULL coverage when every leg has a promotion and collapses identical promo legs", () => {
    const preview = summarizePromotionPricingLegs([
      promoLeg({ id: "p1", basePrice: 50_000, finalPrice: 40_000, discountValue: 20 }),
      promoLeg({ id: "p1", basePrice: 50_000, finalPrice: 40_000, discountValue: 20 }),
    ]);

    expect(preview.discountCoverage).toBe("FULL");
    expect(preview.compareAtBaseTotal).toBe(100_000);
    expect(preview.baseTotal).toBe(80_000);
    expect(preview.segments).toHaveLength(1);
    expect(preview.segments[0]).toMatchObject({
      kind: "PROMO",
      units: 2,
      unitPrice: 40_000,
      total: 80_000,
      compareAtUnitPrice: 50_000,
      label: "20% OFF",
    });
  });

  it("returns PARTIAL coverage when promotions only overlap some legs and orders PROMO segments first", () => {
    const preview = summarizePromotionPricingLegs([
      standardLeg(50_000),
      promoLeg({
        id: "p1",
        basePrice: 50_000,
        finalPrice: 40_000,
        discountValue: 20,
        name: "Spring Sale",
      }),
      standardLeg(50_000),
    ]);

    expect(preview.discountCoverage).toBe("PARTIAL");
    expect(preview.compareAtBaseTotal).toBe(150_000);
    expect(preview.baseTotal).toBe(140_000);
    expect(preview.segments).toHaveLength(2);
    expect(preview.segments[0]).toMatchObject({
      kind: "PROMO",
      units: 1,
      label: "Spring Sale",
    });
    expect(preview.segments[1]).toMatchObject({ kind: "STANDARD", units: 2 });
  });

  it("keeps different promotion ids as separate segments even when price is identical", () => {
    const preview = summarizePromotionPricingLegs([
      promoLeg({ id: "a", basePrice: 50_000, finalPrice: 40_000, discountValue: 20 }),
      promoLeg({ id: "b", basePrice: 50_000, finalPrice: 40_000, discountValue: 20 }),
    ]);

    expect(preview.segments).toHaveLength(2);
  });

  it("uses discount percentage fallback label when promotion name is blank", () => {
    const preview = summarizePromotionPricingLegs([
      promoLeg({ id: "p", basePrice: 50_000, finalPrice: 40_000, discountValue: 20, name: "  " }),
    ]);

    expect(preview.segments[0].label).toBe("20% OFF");
  });
});
