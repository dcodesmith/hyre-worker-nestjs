import type {
  PromotionDiscountCoverage,
  PromotionLegSummaryInput,
  PromotionPricingPreview,
  PromotionPricingSegment,
} from "./promotion.interface";

function formatPromotionLabel(
  promotion: NonNullable<PromotionLegSummaryInput["promotion"]>,
): string {
  if (promotion.name?.trim()) {
    return promotion.name.trim();
  }
  return `${Number(promotion.discountValue)}% OFF`;
}

function createSegmentKey(input: PromotionLegSummaryInput): string {
  if (input.promotion) {
    return `promo:${input.promotion.id}:${input.basePrice}:${input.finalPrice}`;
  }
  return `standard:${input.basePrice}`;
}

function computeCoverage(discountedUnits: number, totalUnits: number): PromotionDiscountCoverage {
  if (discountedUnits === 0) return "NONE";
  if (discountedUnits === totalUnits) return "FULL";
  return "PARTIAL";
}

/**
 * Build a UI-friendly pricing preview from per-leg promo pricing.
 *
 * Segments are merged by (kind, basePrice, finalPrice, promotionId) so legs
 * that share the same price collapse into a single row with a unit count.
 * Partial-overlap discounts remain visible because differing promotions or
 * unit prices produce separate rows.
 */
export function summarizePromotionPricingLegs(
  legs: PromotionLegSummaryInput[],
): PromotionPricingPreview {
  if (legs.length === 0) {
    return {
      baseTotal: 0,
      compareAtBaseTotal: 0,
      discountCoverage: "NONE",
      segments: [],
    };
  }

  const segmentsByKey = new Map<string, PromotionPricingSegment>();
  let baseTotal = 0;
  let compareAtBaseTotal = 0;
  let discountedUnits = 0;

  for (const leg of legs) {
    baseTotal += leg.finalPrice;
    compareAtBaseTotal += leg.basePrice;

    if (leg.promotion) {
      discountedUnits += 1;
    }

    const key = createSegmentKey(leg);
    const existing = segmentsByKey.get(key);

    if (existing) {
      existing.units += 1;
      existing.total += leg.finalPrice;
      continue;
    }

    segmentsByKey.set(key, {
      kind: leg.promotion ? "PROMO" : "STANDARD",
      units: 1,
      unitPrice: leg.finalPrice,
      total: leg.finalPrice,
      compareAtUnitPrice: leg.promotion ? leg.basePrice : null,
      label: leg.promotion ? formatPromotionLabel(leg.promotion) : null,
    });
  }

  const segments = [...segmentsByKey.values()].sort((a, b) => {
    if (a.kind === b.kind) return 0;
    return a.kind === "PROMO" ? -1 : 1;
  });

  return {
    baseTotal,
    compareAtBaseTotal,
    discountCoverage: computeCoverage(discountedUnits, legs.length),
    segments,
  };
}
