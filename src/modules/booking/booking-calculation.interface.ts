import type { BookingType, Car } from "@prisma/client";
import type Decimal from "decimal.js";
import type { ActivePromotion } from "../promotion/promotion.interface";
import type { GeneratedLeg } from "./booking.interface";

/**
 * Promotion metadata recorded on a discounted leg price.
 * Kept as a narrow projection so call-sites don't take a dependency on
 * internal Prisma columns.
 */
export interface LegPricePromotion {
  id: string;
  name: string | null;
  discountValue: Decimal;
}

/**
 * Price for a single booking leg.
 *
 * `basePrice` is the pre-promotion rate for the booking type.
 * `price` is the amount the customer actually pays for the leg (equal to
 * `basePrice` when no promotion applies).
 * `promotion` is set when a promotion discounted this leg.
 */
export interface LegPrice {
  legDate: Date;
  price: Decimal;
  basePrice: Decimal;
  promotion: LegPricePromotion | null;
}

/**
 * Car pricing information needed for calculations.
 * Derived from Prisma Car model to ensure type safety with DB schema.
 */
export type CarPricing = Pick<
  Car,
  | "dayRate"
  | "nightRate"
  | "fullDayRate"
  | "airportPickupRate"
  | "fuelUpgradeRate"
  | "pricingIncludesFuel"
>;

/**
 * Car identity + pricing used by the calculation service.
 * `id` and `ownerId` are required when the caller wants promotions resolved
 * against persisted rows; the calculation service tolerates missing fields
 * by falling back to the pure rate math (used by unit tests and any
 * caller not integrated with promotions yet).
 */
export type CarPricingWithIdentity = CarPricing & {
  id?: string;
  ownerId?: string;
};

/**
 * Input for booking cost calculation
 */
export interface BookingCalculationInput {
  bookingType: BookingType;
  legs: GeneratedLeg[];
  car: CarPricingWithIdentity;
  includeSecurityDetail: boolean;
  requiresFullTank: boolean;
  /** User's available credit balance (optional) */
  userCreditsBalance?: Decimal;
  /** Amount of credits to use (cannot exceed balance or subtotal) */
  creditsToUse?: Decimal;
  /** Referral discount amount (if eligible) */
  referralDiscountAmount?: Decimal;
}

/**
 * Complete financial breakdown for a booking.
 * All monetary amounts are Decimal for precision.
 */
export interface BookingFinancials {
  // Leg pricing
  legPrices: LegPrice[];
  numberOfLegs: number;
  netTotal: Decimal;
  /**
   * Sum of `basePrice` across all legs — the "compare-at" total used for
   * strike-through displays when any leg was discounted. Equal to `netTotal`
   * when no promotion applied.
   */
  compareAtNetTotal: Decimal;
  /**
   * First promotion that applied to any leg (used for single-promo displays
   * and bookkeeping). Null when no leg was discounted.
   */
  appliedPromotion: ActivePromotion | null;

  // Add-ons
  securityDetailCost: Decimal;
  fuelUpgradeCost: Decimal;
  netTotalWithAddons: Decimal;

  // Platform fee (customer pays)
  /** Base amount for platform fee: netTotal + fuelUpgrade (excludes security) */
  platformFeeBase: Decimal;
  platformCustomerServiceFeeRatePercent: Decimal;
  platformCustomerServiceFeeAmount: Decimal;

  // Subtotals
  subtotalBeforeDiscounts: Decimal;
  referralDiscountAmount: Decimal;
  creditsUsed: Decimal;
  subtotalAfterDiscounts: Decimal;

  // VAT
  vatRatePercent: Decimal;
  vatAmount: Decimal;

  // Total customer pays
  totalAmount: Decimal;

  // Fleet owner side
  platformFleetOwnerCommissionRatePercent: Decimal;
  platformFleetOwnerCommissionAmount: Decimal;
  fleetOwnerPayoutAmountNet: Decimal;
}
