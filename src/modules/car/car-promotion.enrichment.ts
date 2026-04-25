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
        carIds: targets.map((target) => target.id),
        ownerIds: [...new Set(targets.map((target) => target.ownerId))],
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
        ownerId: target.ownerId,
        error: promotionError instanceof Error ? promotionError.message : String(promotionError),
      });
      return null;
    }
  }
}
