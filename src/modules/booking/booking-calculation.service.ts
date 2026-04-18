import { Injectable, Logger } from "@nestjs/common";
import type { BookingType } from "@prisma/client";
import Decimal from "decimal.js";
import type { ActivePromotion } from "../promotion/promotion.interface";
import { PromotionService } from "../promotion/promotion.service";
import { RatesService } from "../rates/rates.service";
import { MAX_LEGS_FOR_FUEL_UPGRADE } from "./booking.const";
import type { GeneratedLeg } from "./booking.interface";
import type {
  BookingCalculationInput,
  BookingFinancials,
  CarPricing,
  CarPricingWithIdentity,
  LegPrice,
} from "./booking-calculation.interface";

/**
 * Service for calculating booking financials.
 *
 * Handles the complete financial breakdown including:
 * - Leg pricing based on booking type (with per-leg promotion resolution)
 * - Add-ons (security detail, fuel upgrade)
 * - Platform fees
 * - Discounts (referral, credits)
 * - VAT
 * - Fleet owner commission and payout
 *
 * Promotion integration:
 * The service queries `PromotionService` for every overlapping promotion
 * covering the full booking window, then picks the best promotion per leg.
 * This lets legs that fall outside a promo window pay the standard rate
 * while legs inside the window get discounted — matching the behavior of
 * the Remix implementation in `/hireApp`.
 */
@Injectable()
export class BookingCalculationService {
  private readonly logger = new Logger(BookingCalculationService.name);

  constructor(
    private readonly ratesService: RatesService,
    private readonly promotionService: PromotionService,
  ) {}

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

    const rates = await this.ratesService.getRates();

    const overlappingPromotions = await this.loadOverlappingPromotions(car, legs);
    const legPrices = this.calculateLegPrices(legs, bookingType, car, overlappingPromotions);
    const numberOfLegs = legs.length;
    const netTotal = legPrices.reduce((sum, leg) => sum.add(leg.price), new Decimal(0));
    const compareAtNetTotal = legPrices.reduce(
      (sum, leg) => sum.add(leg.basePrice),
      new Decimal(0),
    );
    const appliedPromotion = this.firstPromotion(legPrices, overlappingPromotions);

    const securityDetailCost = includeSecurityDetail
      ? rates.securityDetailRate.mul(numberOfLegs)
      : new Decimal(0);

    const fuelUpgradeCost = this.calculateFuelUpgradeCost(car, requiresFullTank, numberOfLegs);

    const netTotalWithAddons = netTotal.add(securityDetailCost).add(fuelUpgradeCost);

    const platformFeeBase = netTotal.add(fuelUpgradeCost);
    const platformCustomerServiceFeeRatePercent = rates.platformCustomerServiceFeeRatePercent;
    const platformCustomerServiceFeeAmount = platformFeeBase
      .mul(platformCustomerServiceFeeRatePercent)
      .div(100);

    const subtotalBeforeDiscounts = netTotalWithAddons.add(platformCustomerServiceFeeAmount);

    const effectiveReferralDiscount = this.applyDiscount(
      referralDiscountAmount ?? new Decimal(0),
      subtotalBeforeDiscounts,
    );

    const afterReferral = subtotalBeforeDiscounts.sub(effectiveReferralDiscount);

    const effectiveCredits = this.calculateEffectiveCredits(
      creditsToUse ?? new Decimal(0),
      userCreditsBalance ?? new Decimal(0),
      afterReferral,
    );

    const subtotalAfterDiscounts = afterReferral.sub(effectiveCredits);

    const vatRatePercent = rates.vatRatePercent;
    const vatAmount = subtotalAfterDiscounts.mul(vatRatePercent).div(100);

    const totalAmount = subtotalAfterDiscounts.add(vatAmount);

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
      legPrices,
      numberOfLegs,
      netTotal,
      compareAtNetTotal,
      appliedPromotion,

      securityDetailCost,
      fuelUpgradeCost,
      netTotalWithAddons,

      platformFeeBase,
      platformCustomerServiceFeeRatePercent,
      platformCustomerServiceFeeAmount,

      subtotalBeforeDiscounts,
      referralDiscountAmount: effectiveReferralDiscount,
      creditsUsed: effectiveCredits,
      subtotalAfterDiscounts,

      vatRatePercent,
      vatAmount,

      totalAmount,

      platformFleetOwnerCommissionRatePercent,
      platformFleetOwnerCommissionAmount,
      fleetOwnerPayoutAmountNet,
    };
  }

  /**
   * Fetch every promotion overlapping the full booking window in a single
   * query. Per-leg resolution happens client-side in memory against this list
   * so we only hit the DB once per booking calculation.
   *
   * Returns `[]` when:
   * - the caller didn't supply `car.id` / `car.ownerId` (pure mode, used by
   *   unit tests that don't care about promotions)
   * - the booking has no legs
   */
  private async loadOverlappingPromotions(
    car: CarPricingWithIdentity,
    legs: GeneratedLeg[],
  ): Promise<ActivePromotion[]> {
    if (!car.id || !car.ownerId || legs.length === 0) {
      return [];
    }

    const { start, endExclusive } = this.getBookingWindow(legs);
    if (endExclusive <= start) {
      return [];
    }

    try {
      return await this.promotionService.getOverlappingPromotionsForCar(
        car.id,
        car.ownerId,
        start,
        endExclusive,
      );
    } catch (error) {
      this.logger.warn(
        "Failed to fetch promotions for booking calculation; continuing without promo",
        {
          carId: car.id,
          ownerId: car.ownerId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return [];
    }
  }

  private getBookingWindow(legs: GeneratedLeg[]): { start: Date; endExclusive: Date } {
    let start = legs[0].legStartTime;
    let endExclusive = legs[0].legEndTime;

    for (const leg of legs) {
      if (leg.legStartTime < start) start = leg.legStartTime;
      if (leg.legEndTime > endExclusive) endExclusive = leg.legEndTime;
    }

    return { start, endExclusive };
  }

  /**
   * Calculate price for each leg based on booking type, applying the best
   * overlapping promotion (if any).
   */
  private calculateLegPrices(
    legs: GeneratedLeg[],
    bookingType: BookingType,
    car: CarPricingWithIdentity,
    overlappingPromotions: ActivePromotion[],
  ): LegPrice[] {
    const ratePerLeg = this.getRateForBookingType(bookingType, car);

    return legs.map((leg) => {
      const basePrice = new Decimal(ratePerLeg);
      const legPromotion =
        overlappingPromotions.length === 0 || !car.id
          ? null
          : PromotionService.resolveBestPromotionForInterval({
              promotions: overlappingPromotions,
              carId: car.id,
              intervalStart: leg.legStartTime,
              intervalEndExclusive: leg.legEndTime,
              baseAmount: ratePerLeg,
            });

      if (!legPromotion) {
        return {
          legDate: leg.legDate,
          price: basePrice,
          basePrice,
          promotion: null,
        };
      }

      const discountedRate = PromotionService.applyPromotionDiscount(ratePerLeg, legPromotion);

      return {
        legDate: leg.legDate,
        price: new Decimal(discountedRate),
        basePrice,
        promotion: {
          id: legPromotion.id,
          name: legPromotion.name,
          discountValue: new Decimal(legPromotion.discountValue.toString()),
        },
      };
    });
  }

  /**
   * Return the first promotion that actually applied to any leg.
   *
   * We search `legPrices` (not `overlappingPromotions`) so this field reflects
   * what was really charged — if multiple promotions overlapped but only one
   * was chosen, we record that one.
   */
  private firstPromotion(
    legPrices: LegPrice[],
    overlappingPromotions: ActivePromotion[],
  ): ActivePromotion | null {
    for (const leg of legPrices) {
      if (!leg.promotion) continue;
      const match = overlappingPromotions.find((p) => p.id === leg.promotion?.id);
      if (match) return match;
    }
    return null;
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
   */
  private calculateEffectiveCredits(
    creditsToUse: Decimal,
    userBalance: Decimal,
    remainingSubtotal: Decimal,
  ): Decimal {
    if (creditsToUse.lte(0) || userBalance.lte(0)) {
      return new Decimal(0);
    }

    const cappedAtBalance = Decimal.min(creditsToUse, userBalance);

    return Decimal.min(cappedAtBalance, remainingSubtotal);
  }
}
