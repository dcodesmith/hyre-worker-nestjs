import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { fromZonedTime } from "date-fns-tz";
import Decimal from "decimal.js";
import { DatabaseService } from "../database/database.service";
import { MAX_PROMOTION_PERCENTAGE } from "./promotion.constants";
import type {
  ActivePromotion,
  PromotionDiscountInput,
  PromotionForCreate,
  PromotionListItem,
  PromotionWindowInput,
} from "./promotion.interface";

const LAGOS_TIMEZONE = "Africa/Lagos";
const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validateCalendarDateInput(dateValue: string, label: string): string {
  if (!CALENDAR_DATE_PATTERN.test(dateValue)) {
    throw new BadRequestException(`${label} must be in YYYY-MM-DD format`);
  }
  return dateValue;
}

function addOneDayToCalendarDate(dateValue: string): string {
  const [year, month, day] = dateValue.split("-").map(Number);
  const utcDate = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
  utcDate.setUTCDate(utcDate.getUTCDate() + 1);

  const y = utcDate.getUTCFullYear();
  const m = String(utcDate.getUTCMonth() + 1).padStart(2, "0");
  const d = String(utcDate.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function intervalOverlaps(
  startA: Date,
  endAExclusive: Date,
  startB: Date,
  endBExclusive: Date,
): boolean {
  return startA < endBExclusive && endAExclusive > startB;
}

function getPromotionSelectionCandidates(
  promotions: ActivePromotion[],
  carId: string,
): ActivePromotion[] {
  const carSpecificPromotions = promotions.filter((promotion) => promotion.carId === carId);
  if (carSpecificPromotions.length > 0) {
    return carSpecificPromotions;
  }
  return promotions.filter((promotion) => promotion.carId === null);
}

@Injectable()
export class PromotionsService {
  private readonly logger = new Logger(PromotionsService.name);

  constructor(private readonly databaseService: DatabaseService) {}

  toPromotionWindowExclusive(input: PromotionWindowInput): { startDate: Date; endDate: Date } {
    const timeZone = input.timeZone ?? LAGOS_TIMEZONE;
    const startDate = validateCalendarDateInput(input.startDate, "Start date");
    const endDateInclusive = validateCalendarDateInput(input.endDateInclusive, "End date");
    const endExclusiveDate = addOneDayToCalendarDate(endDateInclusive);

    return {
      startDate: fromZonedTime(`${startDate}T00:00:00`, timeZone),
      endDate: fromZonedTime(`${endExclusiveDate}T00:00:00`, timeZone),
    };
  }

  resolveBestPromotionForInterval(input: {
    promotions: ActivePromotion[];
    carId: string;
    intervalStart: Date;
    intervalEndExclusive: Date;
    baseAmount?: Decimal;
  }): ActivePromotion | null {
    const eligiblePromotions = input.promotions.filter((promotion) =>
      intervalOverlaps(
        promotion.startDate,
        promotion.endDate,
        input.intervalStart,
        input.intervalEndExclusive,
      ),
    );

    const candidates = getPromotionSelectionCandidates(eligiblePromotions, input.carId);
    return this.chooseBestPromotionByDiscount(candidates, input.baseAmount);
  }

  applyPromotionDiscount(input: PromotionDiscountInput): Decimal {
    const discount = input.originalRate.mul(input.discountPercent).div(100);
    return Decimal.max(new Decimal(1), input.originalRate.minus(discount));
  }

  async getOverlappingPromotionsForCar(
    carId: string,
    ownerId: string,
    intervalStart: Date,
    intervalEndExclusive: Date,
  ): Promise<ActivePromotion[]> {
    if (intervalEndExclusive <= intervalStart) {
      return [];
    }

    return this.databaseService.promotion.findMany({
      where: {
        ownerId,
        isActive: true,
        startDate: { lt: intervalEndExclusive },
        endDate: { gt: intervalStart },
        OR: [{ carId }, { carId: null }],
      },
      select: {
        id: true,
        name: true,
        discountValue: true,
        startDate: true,
        endDate: true,
        carId: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async getOwnerPromotions(ownerId: string): Promise<PromotionListItem[]> {
    const promotions = await this.databaseService.promotion.findMany({
      where: { ownerId },
      include: {
        car: {
          select: { id: true, make: true, model: true, year: true, registrationNumber: true },
        },
      },
      orderBy: [{ isActive: "desc" }, { endDate: "desc" }],
    });

    return promotions.map((promotion) => ({
      id: promotion.id,
      ownerId: promotion.ownerId,
      carId: promotion.carId,
      name: promotion.name,
      discountValue: new Decimal(promotion.discountValue.toString()).toNumber(),
      startDate: promotion.startDate.toISOString(),
      endDate: promotion.endDate.toISOString(),
      isActive: promotion.isActive,
      createdAt: promotion.createdAt.toISOString(),
      updatedAt: promotion.updatedAt.toISOString(),
      car: promotion.car,
    }));
  }

  async createPromotion(data: PromotionForCreate) {
    if (data.discountValue <= 0) {
      throw new BadRequestException("Discount value must be positive");
    }
    if (data.discountValue > MAX_PROMOTION_PERCENTAGE) {
      throw new BadRequestException(`Discount cannot exceed ${MAX_PROMOTION_PERCENTAGE}%`);
    }
    if (data.endDate <= data.startDate) {
      throw new BadRequestException("End date must be after start date");
    }

    if (data.carId) {
      const car = await this.databaseService.car.findFirst({
        where: { id: data.carId, ownerId: data.ownerId },
        select: { id: true },
      });
      if (!car) {
        throw new NotFoundException("Car not found for owner");
      }
    }

    const conflictingPromotion = await this.databaseService.promotion.findFirst({
      where: {
        ownerId: data.ownerId,
        isActive: true,
        startDate: { lt: data.endDate },
        endDate: { gt: data.startDate },
        carId: data.carId ?? null,
      },
      select: { id: true },
    });

    if (conflictingPromotion) {
      throw new BadRequestException(
        "An overlapping promotion already exists for this scope. Deactivate or reschedule it first.",
      );
    }

    const promotion = await this.databaseService.promotion.create({
      data: {
        ownerId: data.ownerId,
        carId: data.carId ?? null,
        name: data.name,
        discountValue: data.discountValue,
        startDate: data.startDate,
        endDate: data.endDate,
      },
    });

    this.logger.log("Promotion created", {
      promotionId: promotion.id,
      ownerId: data.ownerId,
      carId: data.carId ?? null,
      discountPercent: data.discountValue,
    });

    return promotion;
  }

  async deactivatePromotion(promotionId: string, ownerId: string) {
    const existing = await this.databaseService.promotion.findFirst({
      where: { id: promotionId, ownerId },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException("Promotion not found");
    }

    return this.databaseService.promotion.update({
      where: { id: promotionId },
      data: { isActive: false },
    });
  }

  private chooseBestPromotionByDiscount(
    candidates: ActivePromotion[],
    baseAmount?: Decimal,
  ): ActivePromotion | null {
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    if (!baseAmount) {
      return candidates[0];
    }

    return candidates.reduce((best, current) => {
      const bestDiscount = this.getPromotionDiscountAmount(best, baseAmount);
      const currentDiscount = this.getPromotionDiscountAmount(current, baseAmount);

      if (currentDiscount.gt(bestDiscount)) return current;
      if (currentDiscount.eq(bestDiscount) && current.createdAt > best.createdAt) return current;
      return best;
    });
  }

  private getPromotionDiscountAmount(promotion: ActivePromotion, baseAmount: Decimal): Decimal {
    const value = new Decimal(promotion.discountValue.toString());
    return baseAmount.mul(value).div(100);
  }
}
