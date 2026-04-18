import type { Promotion } from "@prisma/client";

/**
 * Projection of the Promotion row used by pricing logic.
 *
 * Only fields required to decide which promotion applies and compute the
 * discount. Keep this narrow so downstream code doesn't depend on internal
 * columns like `isActive` (those are filtered at query time).
 */
export type ActivePromotion = Pick<
  Promotion,
  "id" | "name" | "discountValue" | "startDate" | "endDate" | "carId" | "createdAt"
>;

export type PromotionWindow = {
  startDate: Date;
  endDate: Date;
};

export type PromotionPricingSegmentKind = "PROMO" | "STANDARD";

export interface PromotionPricingSegment {
  kind: PromotionPricingSegmentKind;
  units: number;
  unitPrice: number;
  total: number;
  compareAtUnitPrice: number | null;
  label: string | null;
}

export type PromotionDiscountCoverage = "NONE" | "PARTIAL" | "FULL";

export interface PromotionPricingPreview {
  baseTotal: number;
  compareAtBaseTotal: number;
  discountCoverage: PromotionDiscountCoverage;
  segments: PromotionPricingSegment[];
}

export type PromotionLegSummaryInput = {
  basePrice: number;
  finalPrice: number;
  promotion: {
    id: string;
    discountValue: number | string;
    name?: string | null;
  } | null;
};
