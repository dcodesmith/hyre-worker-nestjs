import { Injectable } from "@nestjs/common";
import Decimal from "decimal.js";
import { PinoLogger } from "nestjs-pino";
import { normalizeBookingTimeWindow } from "../../shared/booking-time-window.helper";
import type { AuthSession } from "../auth/guards/session.guard";
import type { BookingFinancials, LegPrice } from "./booking-calculation.interface";
import { BookingCalculationService } from "./booking-calculation.service";
import { BookingEligibilityService } from "./booking-eligibility.service";
import { BookingLegService } from "./booking-leg.service";
import { buildLegGenerationInput } from "./booking-leg-input.builder";
import { BookingPersistenceService } from "./booking-persistence.service";
import type {
  BookingPricingPreviewResponseDto,
  PricingPreviewBodyDto,
  PricingPreviewDiscountCoverage,
  PricingPreviewSegmentDto,
} from "./dto/pricing-preview.dto";

type MutableSegment = Omit<PricingPreviewSegmentDto, "promotion"> & {
  promotion: PricingPreviewSegmentDto["promotion"];
};

@Injectable()
export class BookingPricingPreviewService {
  constructor(
    private readonly bookingPersistenceService: BookingPersistenceService,
    private readonly bookingLegService: BookingLegService,
    private readonly bookingCalculationService: BookingCalculationService,
    private readonly bookingEligibilityService: BookingEligibilityService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(BookingPricingPreviewService.name);
  }

  async preview(
    input: PricingPreviewBodyDto,
    sessionUser: AuthSession["user"] | null = null,
  ): Promise<BookingPricingPreviewResponseDto> {
    this.logger.debug(
      {
        carId: input.carId,
        bookingType: input.bookingType,
        startDate: input.startDate.toISOString(),
        endDate: input.endDate.toISOString(),
        pickupTime: input.pickupTime ?? null,
        includeSecurityDetail: input.includeSecurityDetail,
        requiresFullTank: input.requiresFullTank,
      },
      "Received pricing-preview request",
    );

    const normalized = normalizeBookingTimeWindow({
      bookingType: input.bookingType,
      startDate: input.startDate,
      endDate: input.endDate,
      pickupTime: input.pickupTime,
    });
    this.logger.debug(
      {
        carId: input.carId,
        bookingType: input.bookingType,
        normalizedStartDate: normalized.startDate.toISOString(),
        normalizedEndDate: normalized.endDate.toISOString(),
      },
      "Normalized pricing-preview booking window",
    );

    const car = await this.bookingPersistenceService.fetchCarWithPricing(input.carId);
    const legs = this.bookingLegService.generateLegs(
      buildLegGenerationInput({
        bookingType: input.bookingType,
        startDate: normalized.startDate,
        endDate: normalized.endDate,
        pickupTime: input.pickupTime,
      }),
    );

    const baseFinancials = await this.bookingCalculationService.calculateBookingCost({
      bookingType: input.bookingType,
      legs,
      car,
      includeSecurityDetail: input.includeSecurityDetail,
      requiresFullTank: input.requiresFullTank,
      userCreditsBalance: new Decimal(0),
      creditsToUse: new Decimal(0),
      referralDiscountAmount: new Decimal(0),
    });
    const referralEligibility =
      await this.bookingEligibilityService.checkReferralEligibilityForPricing(
        sessionUser,
        baseFinancials.subtotalBeforeDiscounts,
        input.bookingType,
      );

    const financials = referralEligibility.discountAmount.gt(0)
      ? await this.bookingCalculationService.calculateBookingCost({
          bookingType: input.bookingType,
          legs,
          car,
          includeSecurityDetail: input.includeSecurityDetail,
          requiresFullTank: input.requiresFullTank,
          userCreditsBalance: new Decimal(0),
          creditsToUse: new Decimal(0),
          referralDiscountAmount: referralEligibility.discountAmount,
        })
      : baseFinancials;

    const response = this.mapPreviewResponse(financials);
    this.logger.debug(
      {
        carId: input.carId,
        bookingType: input.bookingType,
        numberOfLegs: response.numberOfLegs,
        discountCoverage: response.discountCoverage,
        segments: response.segments.length,
        totalAmount: response.totalAmount,
      },
      "Computed pricing-preview response",
    );
    return response;
  }

  private mapPreviewResponse(financials: BookingFinancials): BookingPricingPreviewResponseDto {
    const segments = this.buildSegments(financials.legPrices);
    const discountCoverage = this.computeCoverage(financials.legPrices);

    const compareAtPlatformFeeAmount = financials.compareAtNetTotal
      .add(financials.fuelUpgradeCost)
      .mul(financials.platformCustomerServiceFeeRatePercent)
      .div(100);

    const compareAtSubtotalBeforeDiscounts = financials.compareAtNetTotal
      .add(financials.securityDetailCost)
      .add(financials.fuelUpgradeCost)
      .add(compareAtPlatformFeeAmount);

    const compareAtVatAmount = compareAtSubtotalBeforeDiscounts
      .mul(financials.vatRatePercent)
      .div(100);
    const compareAtTotalAmount = compareAtSubtotalBeforeDiscounts.add(compareAtVatAmount);
    const savingsAmount = Decimal.max(
      new Decimal(0),
      compareAtTotalAmount.sub(financials.totalAmount),
    );

    return {
      currency: "NGN",
      numberOfLegs: financials.numberOfLegs,
      discountCoverage,
      segments,
      baseTotal: financials.netTotal.toNumber(),
      compareAtBaseTotal: financials.compareAtNetTotal.toNumber(),
      securityDetailCost: financials.securityDetailCost.toNumber(),
      fuelUpgradeCost: financials.fuelUpgradeCost.toNumber(),
      platformFeeRatePercent: financials.platformCustomerServiceFeeRatePercent.toNumber(),
      platformFeeAmount: financials.platformCustomerServiceFeeAmount.toNumber(),
      compareAtPlatformFeeAmount: compareAtPlatformFeeAmount.toNumber(),
      subtotalBeforeDiscounts: financials.subtotalBeforeDiscounts.toNumber(),
      compareAtSubtotalBeforeDiscounts: compareAtSubtotalBeforeDiscounts.toNumber(),
      referralDiscountAmount: financials.referralDiscountAmount.toNumber(),
      creditsUsed: financials.creditsUsed.toNumber(),
      subtotalAfterDiscounts: financials.subtotalAfterDiscounts.toNumber(),
      vatRatePercent: financials.vatRatePercent.toNumber(),
      vatAmount: financials.vatAmount.toNumber(),
      compareAtVatAmount: compareAtVatAmount.toNumber(),
      totalAmount: financials.totalAmount.toNumber(),
      compareAtTotalAmount: compareAtTotalAmount.toNumber(),
      savingsAmount: savingsAmount.toNumber(),
    };
  }

  private computeCoverage(legPrices: LegPrice[]): PricingPreviewDiscountCoverage {
    if (legPrices.length === 0) {
      return "NONE";
    }

    const discountedUnits = legPrices.filter((leg) => leg.promotion !== null).length;

    if (discountedUnits === 0) {
      return "NONE";
    }

    if (discountedUnits === legPrices.length) {
      return "FULL";
    }

    return "PARTIAL";
  }

  private buildSegments(legPrices: LegPrice[]): PricingPreviewSegmentDto[] {
    const grouped = new Map<string, MutableSegment>();

    for (const leg of legPrices) {
      const unitPrice = leg.price.toNumber();
      const compareAtUnitPrice = leg.promotion ? leg.basePrice.toNumber() : null;
      const key = leg.promotion
        ? `promo:${leg.promotion.id}:${leg.basePrice.toString()}:${leg.price.toString()}`
        : `standard:${leg.basePrice.toString()}`;
      const existing = grouped.get(key);

      if (existing) {
        existing.units += 1;
        existing.total += unitPrice;
        continue;
      }

      grouped.set(key, {
        kind: leg.promotion ? "PROMO" : "STANDARD",
        units: 1,
        unitPrice,
        total: unitPrice,
        compareAtUnitPrice,
        label: leg.promotion
          ? (leg.promotion.name?.trim() ?? `${leg.promotion.discountValue.toNumber()}% OFF`)
          : null,
        promotion: leg.promotion
          ? {
              id: leg.promotion.id,
              name: leg.promotion.name,
              discountValue: leg.promotion.discountValue.toNumber(),
              startDate: leg.promotion.startDate?.toISOString(),
              endDateExclusive: leg.promotion.endDate?.toISOString(),
            }
          : null,
      });
    }

    return [...grouped.values()].sort((a, b) => {
      if (a.kind === b.kind) return 0;
      return a.kind === "PROMO" ? -1 : 1;
    });
  }
}
