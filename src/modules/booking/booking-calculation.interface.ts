import type { BookingType, Car } from "@prisma/client";
import type { Decimal } from "@prisma/client/runtime/library";
import type { GeneratedLeg } from "./booking.interface";

/**
 * Price for a single booking leg
 */
export interface LegPrice {
  legDate: Date;
  price: Decimal;
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
  | "hourlyRate"
  | "fuelUpgradeRate"
  | "pricingIncludesFuel"
>;

/**
 * Input for booking cost calculation
 */
export interface BookingCalculationInput {
  bookingType: BookingType;
  legs: GeneratedLeg[];
  car: CarPricing;
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
