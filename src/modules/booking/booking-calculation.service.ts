import { Injectable } from "@nestjs/common";
import type { BookingType } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { RatesService } from "../rates/rates.service";
import { MAX_LEGS_FOR_FUEL_UPGRADE } from "./booking.const";
import type { GeneratedLeg } from "./booking.interface";
import type {
  BookingCalculationInput,
  BookingFinancials,
  CarPricing,
  LegPrice,
} from "./booking-calculation.interface";

/**
 * Service for calculating booking financials.
 *
 * Handles the complete financial breakdown including:
 * - Leg pricing based on booking type
 * - Add-ons (security detail, fuel upgrade)
 * - Platform fees
 * - Discounts (referral, credits)
 * - VAT
 * - Fleet owner commission and payout
 */
@Injectable()
export class BookingCalculationService {
  constructor(private readonly ratesService: RatesService) {}

  /**
   * Calculate complete booking cost breakdown.
   *
   * @param input - Booking calculation parameters
   * @returns Complete financial breakdown
   */
  async calculateBookingCost(input: BookingCalculationInput): Promise<BookingFinancials> {
    const {
      bookingType,
      legs,
      car,
      includeSecurityDetail,
      requiresFullTank,
      userCreditsBalance,
      creditsToUse,
      referralDiscountAmount,
    } = input;

    // Get current platform rates
    const rates = await this.ratesService.getRates();

    // 1. Calculate leg prices
    const legPrices = this.calculateLegPrices(legs, bookingType, car);
    const numberOfLegs = legs.length;
    const netTotal = legPrices.reduce((sum, leg) => sum.add(leg.price), new Decimal(0));

    // 2. Calculate add-ons
    const securityDetailCost = includeSecurityDetail
      ? rates.securityDetailRate.mul(numberOfLegs)
      : new Decimal(0);

    const fuelUpgradeCost = this.calculateFuelUpgradeCost(car, requiresFullTank, numberOfLegs);

    const netTotalWithAddons = netTotal.add(securityDetailCost).add(fuelUpgradeCost);

    // 3. Calculate platform fee (on netTotal + fuelUpgrade, excludes security)
    const platformFeeBase = netTotal.add(fuelUpgradeCost);
    const platformCustomerServiceFeeRatePercent = rates.platformCustomerServiceFeeRatePercent;
    const platformCustomerServiceFeeAmount = platformFeeBase
      .mul(platformCustomerServiceFeeRatePercent)
      .div(100);

    // 4. Calculate subtotal before discounts
    const subtotalBeforeDiscounts = netTotalWithAddons.add(platformCustomerServiceFeeAmount);

    // 5. Apply referral discount (capped at subtotal)
    const effectiveReferralDiscount = this.applyDiscount(
      referralDiscountAmount ?? new Decimal(0),
      subtotalBeforeDiscounts,
    );

    const afterReferral = subtotalBeforeDiscounts.sub(effectiveReferralDiscount);

    // 6. Apply credits (capped at remaining subtotal and user's balance)
    const effectiveCredits = this.calculateEffectiveCredits(
      creditsToUse ?? new Decimal(0),
      userCreditsBalance ?? new Decimal(0),
      afterReferral,
    );

    const subtotalAfterDiscounts = afterReferral.sub(effectiveCredits);

    // 7. Calculate VAT on subtotal after discounts
    const vatRatePercent = rates.vatRatePercent;
    const vatAmount = subtotalAfterDiscounts.mul(vatRatePercent).div(100);

    // 8. Calculate total customer pays
    const totalAmount = subtotalAfterDiscounts.add(vatAmount);

    // 9. Calculate fleet owner commission and payout
    // Commission is calculated on netTotal only (the rental earnings the fleet owner receives).
    // Fuel upgrade is excluded because it goes to refueling, not the fleet owner.
    // Security detail is excluded because it's a pass-through cost.
    const platformFleetOwnerCommissionRatePercent = rates.platformFleetOwnerCommissionRatePercent;
    const platformFleetOwnerCommissionAmount = netTotal
      .mul(platformFleetOwnerCommissionRatePercent)
      .div(100);

    // Fleet owner gets: netTotal + securityDetail - commission
    // (fuel upgrade goes to refueling, not fleet owner; security is pass-through)
    const fleetOwnerPayoutAmountNet = netTotal
      .add(securityDetailCost)
      .sub(platformFleetOwnerCommissionAmount);

    return {
      // Leg pricing
      legPrices,
      numberOfLegs,
      netTotal,

      // Add-ons
      securityDetailCost,
      fuelUpgradeCost,
      netTotalWithAddons,

      // Platform fee
      platformFeeBase,
      platformCustomerServiceFeeRatePercent,
      platformCustomerServiceFeeAmount,

      // Subtotals
      subtotalBeforeDiscounts,
      referralDiscountAmount: effectiveReferralDiscount,
      creditsUsed: effectiveCredits,
      subtotalAfterDiscounts,

      // VAT
      vatRatePercent,
      vatAmount,

      // Total
      totalAmount,

      // Fleet owner
      platformFleetOwnerCommissionRatePercent,
      platformFleetOwnerCommissionAmount,
      fleetOwnerPayoutAmountNet,
    };
  }

  /**
   * Calculate price for each leg based on booking type.
   *
   * @param legs - Generated booking legs
   * @param bookingType - Type of booking (DAY, NIGHT, FULL_DAY, AIRPORT_PICKUP)
   * @param car - Car pricing information
   * @returns Array of leg prices
   */
  private calculateLegPrices(
    legs: GeneratedLeg[],
    bookingType: BookingType,
    car: CarPricing,
  ): LegPrice[] {
    const ratePerLeg = this.getRateForBookingType(bookingType, car);

    return legs.map((leg) => ({
      legDate: leg.legDate,
      price: new Decimal(ratePerLeg),
    }));
  }

  /**
   * Get the appropriate rate for a booking type.
   *
   * @param bookingType - Type of booking
   * @param car - Car pricing information
   * @returns Rate per leg as a number
   */
  private getRateForBookingType(bookingType: BookingType, car: CarPricing): number {
    switch (bookingType) {
      case "DAY":
        return car.dayRate;
      case "NIGHT":
        return car.nightRate;
      case "FULL_DAY":
        return car.fullDayRate;
      case "AIRPORT_PICKUP":
        return car.airportPickupRate;
      default: {
        const exhaustiveCheck: never = bookingType;
        throw new Error(`Unknown booking type: ${exhaustiveCheck}`);
      }
    }
  }

  /**
   * Calculate fuel upgrade cost.
   *
   * Fuel upgrade applies only if:
   * 1. Car pricing doesn't include fuel
   * 2. Customer requests full tank
   * 3. Booking has at least 1 leg and no more than 2 legs
   *
   * @param car - Car pricing information
   * @param requiresFullTank - Whether customer requests full tank
   * @param numberOfLegs - Number of legs in booking
   * @returns Fuel upgrade cost (0 if not applicable)
   */
  private calculateFuelUpgradeCost(
    car: CarPricing,
    requiresFullTank: boolean,
    numberOfLegs: number,
  ): Decimal {
    const isEligible =
      !car.pricingIncludesFuel &&
      requiresFullTank &&
      numberOfLegs > 0 &&
      numberOfLegs <= MAX_LEGS_FOR_FUEL_UPGRADE &&
      car.fuelUpgradeRate !== null &&
      car.fuelUpgradeRate > 0;

    if (!isEligible) {
      return new Decimal(0);
    }

    return new Decimal(car.fuelUpgradeRate);
  }

  /**
   * Apply a discount capped at the available amount.
   *
   * @param discount - Requested discount amount
   * @param availableAmount - Maximum amount that can be discounted
   * @returns Effective discount (min of discount and available)
   */
  private applyDiscount(discount: Decimal, availableAmount: Decimal): Decimal {
    if (discount.lte(0)) {
      return new Decimal(0);
    }
    return Decimal.min(discount, availableAmount);
  }

  /**
   * Calculate effective credits to use.
   *
   * Credits are capped at:
   * 1. The requested amount
   * 2. The user's available balance
   * 3. The remaining subtotal (can't go negative)
   *
   * @param creditsToUse - Requested credits to use
   * @param userBalance - User's available credit balance
   * @param remainingSubtotal - Remaining amount after other discounts
   * @returns Effective credits to apply
   */
  private calculateEffectiveCredits(
    creditsToUse: Decimal,
    userBalance: Decimal,
    remainingSubtotal: Decimal,
  ): Decimal {
    // Early return if no credits requested or no balance available
    if (creditsToUse.lte(0) || userBalance.lte(0)) {
      return new Decimal(0);
    }

    // Cap at user's balance
    const cappedAtBalance = Decimal.min(creditsToUse, userBalance);

    // Cap at remaining subtotal (can't go negative)
    return Decimal.min(cappedAtBalance, remainingSubtotal);
  }
}
