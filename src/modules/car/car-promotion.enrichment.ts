import { Injectable, Logger } from "@nestjs/common";
import type { ActivePromotion } from "../promotion/promotion.interface";
import { PromotionService } from "../promotion/promotion.service";
import type { CarPromotionDto } from "./dto/car-promotion.dto";
import { mapActivePromotionToCarPromotionDto } from "./dto/car-promotion.mapper";

export interface PromotionTarget {
  id: string;
  ownerId: string;
}

interface ResolvePromotionsForCarsParams {
  targets: PromotionTarget[];
  referenceDate: Date;
  failureMessage: string;
}

interface ResolvePromotionForCarParams {
  target: PromotionTarget;
  referenceDate: Date;
  failureMessage: string;
}

interface EnrichCarsWithPromotionParams<T extends PromotionTarget> {
  cars: T[];
  referenceDate: Date;
  failureMessage: string;
}

interface EnrichCarWithPromotionParams<T extends PromotionTarget> {
  car: T;
  referenceDate: Date;
  failureMessage: string;
}

@Injectable()
export class CarPromotionEnrichmentService {
  private readonly logger = new Logger(CarPromotionEnrichmentService.name);

  constructor(private readonly promotionService: PromotionService) {}

  async resolvePromotionsForCars({
    targets,
    referenceDate,
    failureMessage,
  }: ResolvePromotionsForCarsParams): Promise<Map<string, CarPromotionDto | null>> {
    let activePromotionsByCarId = new Map<string, ActivePromotion>();
    try {
      activePromotionsByCarId = await this.promotionService.getActivePromotionsForCars(
        targets,
        referenceDate,
      );
    } catch (promotionError) {
      this.logger.warn(failureMessage, {
        carCount: targets.length,
        ownerCount: new Set(targets.map((target) => target.ownerId)).size,
        error: promotionError instanceof Error ? promotionError.message : String(promotionError),
      });
    }

    return new Map(
      targets.map((target) => [
        target.id,
        mapActivePromotionToCarPromotionDto(activePromotionsByCarId.get(target.id) ?? null),
      ]),
    );
  }

  async resolvePromotionForCar({
    target,
    referenceDate,
    failureMessage,
  }: ResolvePromotionForCarParams): Promise<CarPromotionDto | null> {
    try {
      const promotion = await this.promotionService.getActivePromotionForCar(
        target.id,
        target.ownerId,
        referenceDate,
      );
      return mapActivePromotionToCarPromotionDto(promotion);
    } catch (promotionError) {
      this.logger.warn(failureMessage, {
        carId: target.id,
        ownerIdPresent: Boolean(target.ownerId),
        error: promotionError instanceof Error ? promotionError.message : String(promotionError),
      });
      return null;
    }
  }

  async enrichCarsWithPromotion<T extends PromotionTarget>({
    cars,
    referenceDate,
    failureMessage,
  }: EnrichCarsWithPromotionParams<T>): Promise<Array<T & { promotion: CarPromotionDto | null }>> {
    const targets = cars.map(({ id, ownerId }) => ({ id, ownerId }));
    const promotionsByCarId = await this.resolvePromotionsForCars({
      targets,
      referenceDate,
      failureMessage,
    });

    return cars.map((car) => ({
      ...car,
      promotion: promotionsByCarId.get(car.id) ?? null,
    }));
  }

  async enrichCarWithPromotion<T extends PromotionTarget>({
    car,
    referenceDate,
    failureMessage,
  }: EnrichCarWithPromotionParams<T>): Promise<T & { promotion: CarPromotionDto | null }> {
    const promotion = await this.resolvePromotionForCar({
      target: { id: car.id, ownerId: car.ownerId },
      referenceDate,
      failureMessage,
    });

    return {
      ...car,
      promotion,
    };
  }
}
