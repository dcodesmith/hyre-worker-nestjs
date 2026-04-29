import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, type Promotion } from "@prisma/client";
import { fromZonedTime } from "date-fns-tz";
import Decimal from "decimal.js";
import { PinoLogger } from "nestjs-pino";
import { TIMEZONE } from "../../config/constants";
import type { EnvConfig } from "../../config/env.config";
import { DatabaseService } from "../database/database.service";
import { MAX_PROMOTION_PERCENTAGE, MIN_PROMOTION_PERCENTAGE } from "./dto/promotion.dto";
import {
  PromotionCarNotFoundException,
  PromotionCreateFailedException,
  PromotionException,
  PromotionFetchFailedException,
  PromotionNotFoundException,
  PromotionOverlapException,
  PromotionUpdateFailedException,
  PromotionValidationException,
} from "./promotion.error";
import type {
  ActivePromotion,
  CarOwnerRef,
  CreatePromotionInput,
  DiscountableCarRates,
  OwnerScopedActivePromotion,
  PromotionWindow,
  PromotionWindowInput,
  ResolveBestPromotionForIntervalInput,
} from "./promotion.interface";

const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

@Injectable()
export class PromotionService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly configService: ConfigService<EnvConfig, true>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PromotionService.name);
  }

  toPromotionWindowExclusive(input: PromotionWindowInput): PromotionWindow {
    return PromotionService.toPromotionWindowExclusive({
      ...input,
      timeZone: input.timeZone ?? this.configService.get("TZ", { infer: true }),
    });
  }

  // ---------------------------------------------------------------------------
  // Pure helpers (no DB dependency)
  // ---------------------------------------------------------------------------

  /**
   * Convert user-facing inclusive calendar dates into persisted promotion bounds.
   * Storage is always `[startDate, endDate)` in the business timezone.
   */
  static toPromotionWindowExclusive(input: PromotionWindowInput): PromotionWindow {
    const timeZone = input.timeZone ?? TIMEZONE;
    PromotionService.assertCalendarDate(input.startDate, "Start date");
    PromotionService.assertCalendarDate(input.endDateInclusive, "End date");

    const endExclusive = PromotionService.addOneCalendarDay(input.endDateInclusive);

    const startDate = fromZonedTime(`${input.startDate}T00:00:00`, timeZone);
    const endDate = fromZonedTime(`${endExclusive}T00:00:00`, timeZone);
    if (endDate <= startDate) {
      throw new PromotionValidationException("End date must be after start date");
    }

    return { startDate, endDate };
  }

  /**
   * Resolve the best promotion overlapping the given interval, preferring
   * car-specific promotions over fleet-wide ones. Among same-scope candidates
   * the highest effective discount wins; ties break to the most recently
   * created promotion.
   */
  static resolveBestPromotionForInterval(
    input: ResolveBestPromotionForIntervalInput,
  ): ActivePromotion | null {
    const eligible = input.promotions.filter((promotion) =>
      PromotionService.intervalsOverlap(
        promotion.startDate,
        promotion.endDate,
        input.intervalStart,
        input.intervalEndExclusive,
      ),
    );

    const candidates = PromotionService.getSelectionCandidates(eligible, input.carId);
    return PromotionService.chooseBestPromotion(candidates, input.baseAmount);
  }

  /**
   * Apply a percentage promotion discount to an original rate.
   *
   * Floors the result at 1 (smallest currency unit) so no rate reaches zero —
   * a zero-rate booking would break platform fee and payout calculations.
   */
  static applyPromotionDiscount(originalRate: number, promotion: ActivePromotion): number {
    const value = new Decimal(promotion.discountValue.toString());
    const discount = new Decimal(originalRate).mul(value).div(100);
    return Math.max(1, new Decimal(originalRate).minus(discount).toNumber());
  }

  /**
   * Apply a promotion to all five car rate fields.
   */
  static getDiscountedCarRates(car: DiscountableCarRates, promotion: ActivePromotion) {
    return {
      dayRate: PromotionService.applyPromotionDiscount(car.dayRate, promotion),
      nightRate: PromotionService.applyPromotionDiscount(car.nightRate, promotion),
      hourlyRate: PromotionService.applyPromotionDiscount(car.hourlyRate, promotion),
      fullDayRate: PromotionService.applyPromotionDiscount(car.fullDayRate, promotion),
      airportPickupRate: PromotionService.applyPromotionDiscount(car.airportPickupRate, promotion),
    };
  }

  /** Short display label for badges, e.g. "25% OFF". */
  static getPromotionBadgeLabel(promotion: ActivePromotion): string {
    return `${new Decimal(promotion.discountValue.toString()).toNumber()}% OFF`;
  }

  // ---------------------------------------------------------------------------
  // DB-backed operations
  // ---------------------------------------------------------------------------

  /**
   * Find the best active promotion for a car at a given point in time.
   *
   * Car-specific promotions take priority over fleet-wide promotions.
   * Among same-scope promotions, the largest effective discount wins.
   * If `baseAmount` is omitted and multiple candidates tie, the most recently
   * created promotion is chosen (with a warning log).
   */
  async getActivePromotionForCar(
    carId: string,
    ownerId: string,
    referenceDate: Date = new Date(),
    baseAmount?: number,
  ): Promise<ActivePromotion | null> {
    try {
      const promotions = await this.databaseService.promotion.findMany({
        where: {
          ownerId,
          ...PromotionService.activeAtWhere(referenceDate),
          ...PromotionService.scopeForCar(carId),
        },
        select: PromotionService.ACTIVE_PROMOTION_SELECT,
        orderBy: { createdAt: "desc" },
      });

      if (promotions.length === 0) return null;

      const candidates = PromotionService.getSelectionCandidates(promotions, carId);
      const best = PromotionService.chooseBestPromotion(candidates, baseAmount);

      if (candidates.length > 1 && typeof baseAmount !== "number") {
        this.logger.warn(
          {
            ownerId,
            carId,
            promotionIds: candidates.map((p) => p.id),
          },
          "Multiple active promotions in same scope without baseAmount",
        );
      }

      return best;
    } catch (error) {
      if (error instanceof PromotionException) throw error;
      this.logger.error(
        {
          carId,
          ownerId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to fetch active promotion for car",
      );
      throw new PromotionFetchFailedException();
    }
  }

  /**
   * Batch-fetch active promotions for multiple cars across multiple owners.
   *
   * Returns a `Map<carId, ActivePromotion>` covering only the cars with an
   * applicable (car-specific or fleet-wide) promotion. Per owner and scope
   * (car id or fleet), the row with the highest `discountValue` wins; ties
   * break to the most recently created promotion.
   */
  async getActivePromotionsForCars(
    cars: CarOwnerRef[],
    referenceDate: Date = new Date(),
  ): Promise<Map<string, ActivePromotion>> {
    if (cars.length === 0) return new Map();

    try {
      const ownerIds = [...new Set(cars.map((c) => c.ownerId))];
      const carIds = cars.map((c) => c.id);

      const promotions = await this.databaseService.promotion.findMany({
        where: {
          ownerId: { in: ownerIds },
          ...PromotionService.activeAtWhere(referenceDate),
          OR: [{ carId: { in: carIds } }, { carId: null }],
        },
        select: { ...PromotionService.ACTIVE_PROMOTION_SELECT, ownerId: true },
        orderBy: { createdAt: "desc" },
      });

      const lookup = PromotionService.buildOwnerScopePromotionLookup(promotions);

      const result = new Map<string, ActivePromotion>();
      for (const car of cars) {
        const ownerMap = lookup.get(car.ownerId);
        if (!ownerMap) continue;

        const carSpecific = ownerMap.get(car.id);
        if (carSpecific) {
          result.set(car.id, carSpecific);
          continue;
        }

        const fleetWide = ownerMap.get("fleet");
        if (fleetWide) {
          result.set(car.id, fleetWide);
        }
      }

      return result;
    } catch (error) {
      if (error instanceof PromotionException) throw error;
      this.logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to batch fetch active promotions",
      );
      throw new PromotionFetchFailedException();
    }
  }

  /**
   * Fetch every active promotion for a car owner whose window overlaps the
   * booking interval `[intervalStart, intervalEndExclusive)`.
   *
   * Callers iterate each booking leg and pick the best overlap via
   * `PromotionService.resolveBestPromotionForInterval`.
   */
  async getOverlappingPromotionsForCar(
    carId: string,
    ownerId: string,
    intervalStart: Date,
    intervalEndExclusive: Date,
  ): Promise<ActivePromotion[]> {
    if (intervalEndExclusive <= intervalStart) {
      return [];
    }

    try {
      return await this.databaseService.promotion.findMany({
        where: {
          ownerId,
          ...PromotionService.overlapWhere(intervalStart, intervalEndExclusive),
          ...PromotionService.scopeForCar(carId),
        },
        select: PromotionService.ACTIVE_PROMOTION_SELECT,
        orderBy: { createdAt: "desc" },
      });
    } catch (error) {
      if (error instanceof PromotionException) throw error;
      this.logger.error(
        {
          carId,
          ownerId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to fetch overlapping promotions for car",
      );
      throw new PromotionFetchFailedException();
    }
  }

  /** List every promotion for a fleet owner dashboard. */
  async getOwnerPromotions(ownerId: string) {
    try {
      return await this.databaseService.promotion.findMany({
        where: { ownerId },
        include: {
          car: {
            select: {
              id: true,
              make: true,
              model: true,
              year: true,
              registrationNumber: true,
            },
          },
        },
        orderBy: [{ isActive: "desc" }, { endDate: "desc" }],
      });
    } catch (error) {
      if (error instanceof PromotionException) throw error;
      this.logger.error(
        {
          ownerId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to list owner promotions",
      );
      throw new PromotionFetchFailedException();
    }
  }

  /**
   * Create a new promotion. If `carId` is `null` the promotion targets the
   * owner's entire fleet. Rejects same-scope overlaps (car-specific vs
   * fleet-wide are intentionally allowed to coexist — resolution order at
   * read time handles precedence).
   *
   * Uses a single DB transaction with a transaction-scoped advisory lock on
   * `(ownerId, carId scope)` so overlap checks and insert cannot race with
   * another concurrent create for the same scope.
   */
  async createPromotion(data: CreatePromotionInput): Promise<Promotion> {
    try {
      const { startDate, endDate } = this.toPromotionWindowExclusive({
        startDate: data.startDate,
        endDateInclusive: data.endDate,
        timeZone: data.timeZone,
      });

      if (data.discountValue < MIN_PROMOTION_PERCENTAGE) {
        throw new PromotionValidationException(
          `Discount must be at least ${MIN_PROMOTION_PERCENTAGE}%`,
        );
      }
      if (data.discountValue > MAX_PROMOTION_PERCENTAGE) {
        throw new PromotionValidationException(
          `Discount cannot exceed ${MAX_PROMOTION_PERCENTAGE}%`,
        );
      }
      const promotion = await this.databaseService.$transaction(async (tx) => {
        await PromotionService.acquirePromotionScopeTransactionLock(tx, data.ownerId, data.carId);

        if (data.carId !== null) {
          const car = await tx.car.findFirst({
            where: { id: data.carId, ownerId: data.ownerId },
            select: { id: true },
          });
          if (!car) {
            throw new PromotionCarNotFoundException();
          }
        }

        const conflict = await tx.promotion.findFirst({
          where: {
            ownerId: data.ownerId,
            ...PromotionService.overlapWhere(startDate, endDate),
            carId: data.carId,
          },
          select: { id: true },
        });

        if (conflict) {
          throw new PromotionOverlapException();
        }

        return tx.promotion.create({
          data: {
            ownerId: data.ownerId,
            carId: data.carId,
            name: data.name,
            discountValue: data.discountValue,
            startDate,
            endDate,
          },
        });
      });

      this.logger.info(
        {
          promotionId: promotion.id,
          ownerId: data.ownerId,
          carId: data.carId,
          discountPercent: data.discountValue,
        },
        "Promotion created",
      );

      return promotion;
    } catch (error) {
      if (error instanceof PromotionException) throw error;
      if (PromotionService.isPromotionOverlapConstraintViolation(error)) {
        throw new PromotionOverlapException();
      }
      this.logger.error(
        {
          ownerId: data.ownerId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to create promotion",
      );
      throw new PromotionCreateFailedException();
    }
  }

  /**
   * Soft-disable a promotion. The row stays in the database so historical
   * bookings referencing it remain auditable.
   */
  async deactivatePromotion(promotionId: string, ownerId: string): Promise<Promotion> {
    try {
      const existing = await this.databaseService.promotion.findFirst({
        where: { id: promotionId, ownerId },
        select: { id: true },
      });

      if (!existing) {
        throw new PromotionNotFoundException();
      }

      return await this.databaseService.promotion.update({
        where: { id: promotionId },
        data: { isActive: false },
      });
    } catch (error) {
      if (error instanceof PromotionException) throw error;
      this.logger.error(
        {
          promotionId,
          ownerId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to deactivate promotion",
      );
      throw new PromotionUpdateFailedException();
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Serialize creates for the same (ownerId, carId scope) so overlap detection
   * and insert cannot interleave with another transaction (TOCTOU).
   */
  private static async acquirePromotionScopeTransactionLock(
    tx: Prisma.TransactionClient,
    ownerId: string,
    carId: string | null,
  ): Promise<void> {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtext(${ownerId}::text),
        hashtext(${carId ?? "__hyre_promo_fleet_scope__"}::text)
      )
    `;
  }

  /** Maps a future DB exclusion/unique overlap constraint to the API error. */
  private static isPromotionOverlapConstraintViolation(error: unknown): boolean {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return true;
    }
    if (error instanceof Prisma.PrismaClientUnknownRequestError) {
      const msg = error.message;
      return msg.includes("23P01") || msg.includes("exclusion_violation");
    }
    return false;
  }

  private static readonly ACTIVE_PROMOTION_SELECT = {
    id: true,
    name: true,
    discountValue: true,
    startDate: true,
    endDate: true,
    carId: true,
    createdAt: true,
  } as const;

  private static activeAtWhere(referenceDate: Date) {
    return {
      isActive: true,
      startDate: { lte: referenceDate },
      endDate: { gt: referenceDate },
    } as const;
  }

  private static overlapWhere(intervalStart: Date, intervalEndExclusive: Date) {
    return {
      isActive: true,
      startDate: { lt: intervalEndExclusive },
      endDate: { gt: intervalStart },
    } as const;
  }

  private static scopeForCar(carId: string) {
    return {
      OR: [{ carId }, { carId: null }],
    };
  }

  private static assertCalendarDate(value: string, label: string): void {
    if (!CALENDAR_DATE_PATTERN.test(value)) {
      throw new PromotionValidationException(`${label} must be in YYYY-MM-DD format`);
    }
  }

  private static addOneCalendarDay(calendarDate: string): string {
    const [year, month, day] = calendarDate.split("-").map(Number);
    const utc = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
    utc.setUTCDate(utc.getUTCDate() + 1);

    const y = utc.getUTCFullYear();
    const m = String(utc.getUTCMonth() + 1).padStart(2, "0");
    const d = String(utc.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  private static intervalsOverlap(
    startA: Date,
    endAExclusive: Date,
    startB: Date,
    endBExclusive: Date,
  ): boolean {
    return startA < endBExclusive && endAExclusive > startB;
  }

  private static buildOwnerScopePromotionLookup(
    promotions: OwnerScopedActivePromotion[],
  ): Map<string, Map<string, ActivePromotion>> {
    const lookup = new Map<string, Map<string, ActivePromotion>>();
    for (const promotion of promotions) {
      let ownerMap = lookup.get(promotion.ownerId);
      if (!ownerMap) {
        ownerMap = new Map();
        lookup.set(promotion.ownerId, ownerMap);
      }
      const key = promotion.carId ?? "fleet";
      const existing = ownerMap.get(key);
      if (
        existing === undefined ||
        PromotionService.incomingBeatsExistingForSameScope(existing, promotion)
      ) {
        ownerMap.set(key, promotion);
      }
    }
    return lookup;
  }

  /** True if `incoming` should replace `existing` for the same (owner, scope) bucket. */
  private static incomingBeatsExistingForSameScope(
    existing: ActivePromotion,
    incoming: ActivePromotion,
  ): boolean {
    const existingVal = new Decimal(existing.discountValue.toString());
    const incomingVal = new Decimal(incoming.discountValue.toString());
    if (incomingVal.gt(existingVal)) return true;
    if (incomingVal.lt(existingVal)) return false;
    return incoming.createdAt > existing.createdAt;
  }

  private static getSelectionCandidates(
    promotions: ActivePromotion[],
    carId: string,
  ): ActivePromotion[] {
    const carSpecific = promotions.filter((promotion) => promotion.carId === carId);
    if (carSpecific.length > 0) {
      return carSpecific;
    }
    return promotions.filter((promotion) => promotion.carId === null);
  }

  private static chooseBestPromotion(
    candidates: ActivePromotion[],
    baseAmount?: number,
  ): ActivePromotion | null {
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    if (typeof baseAmount !== "number") {
      return candidates[0];
    }

    const [firstCandidate, ...remainingCandidates] = candidates;
    return remainingCandidates.reduce((best, current) => {
      const bestDiscount = PromotionService.computeDiscountAmount(best, baseAmount);
      const currentDiscount = PromotionService.computeDiscountAmount(current, baseAmount);

      if (currentDiscount.gt(bestDiscount)) return current;
      if (currentDiscount.eq(bestDiscount) && current.createdAt > best.createdAt) return current;
      return best;
    }, firstCandidate);
  }

  private static computeDiscountAmount(promotion: ActivePromotion, baseAmount: number): Decimal {
    const value = new Decimal(promotion.discountValue.toString());
    return new Decimal(baseAmount).mul(value).div(100);
  }
}
