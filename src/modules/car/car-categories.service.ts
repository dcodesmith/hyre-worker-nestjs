import { Injectable, Logger } from "@nestjs/common";
import { CarApprovalStatus, Status } from "@prisma/client";
import { DatabaseService } from "../database/database.service";
import { CarException, CarFetchFailedException } from "./car.error";
import { CarPromotionEnrichmentService } from "./car-promotion.enrichment";
import type {
  CarCategoriesQueryDto,
  CarCategoriesResponseDto,
  CarCategory,
  CategoryName,
  PublicCarDto,
} from "./dto/car-categories.dto";
import { CATEGORY_DEFINITIONS, MIN_CATEGORY_SIZE } from "./dto/car-categories.dto";

@Injectable()
export class CarCategoriesService {
  private readonly logger = new Logger(CarCategoriesService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly carPromotionEnrichmentService: CarPromotionEnrichmentService,
  ) {}

  /**
   * Categorizes cars into meaningful groups for display.
   * Returns an array of categories with name, title, and cars.
   * Only includes categories that meet the minimum size threshold.
   */
  private categorizeCars(cars: PublicCarDto[]): CarCategory[] {
    const buckets: Record<CategoryName, PublicCarDto[]> = {
      suvs: [],
      luxury: [],
      budget: [],
      sedans: [],
      executive: [],
      popular: [],
    };

    for (const car of cars) {
      for (const { name, matcher } of CATEGORY_DEFINITIONS) {
        if (matcher(car)) {
          buckets[name].push(car);
        }
      }
    }

    // Build result array, only including categories that meet minimum size
    return CATEGORY_DEFINITIONS.filter(({ name }) => buckets[name].length >= MIN_CATEGORY_SIZE).map(
      ({ name, title }) => ({
        name,
        title,
        cars: buckets[name],
      }),
    );
  }

  async getCategorizedCars(query: CarCategoriesQueryDto): Promise<CarCategoriesResponseDto> {
    try {
      const cars = await this.databaseService.car.findMany({
        where: {
          status: { in: [Status.AVAILABLE, Status.BOOKED] },
          approvalStatus: CarApprovalStatus.APPROVED,
          owner: { fleetOwnerStatus: "APPROVED", hasOnboarded: true },
        },
        select: {
          id: true,
          ownerId: true,
          make: true,
          model: true,
          year: true,
          dayRate: true,
          passengerCapacity: true,
          pricingIncludesFuel: true,
          vehicleType: true,
          serviceTier: true,
          images: { select: { url: true }, orderBy: { createdAt: "asc" }, take: 3 },
        },
        orderBy: [{ updatedAt: "desc" }, { dayRate: "asc" }],
        take: query.limit,
      });
      const promotionTargets = cars.map((car) => ({ id: car.id, ownerId: car.ownerId }));
      const promotionsByCarId = await this.carPromotionEnrichmentService.resolvePromotionsForCars({
        targets: promotionTargets,
        referenceDate: new Date(),
        failureMessage:
          "Promotion enrichment failed for categorized cars; returning cars without promotions",
      });
      const enrichedCars = cars.map((car) => {
        const publicCar = { ...car };
        delete publicCar.ownerId;

        return {
          ...publicCar,
          promotion: promotionsByCarId.get(car.id) ?? null,
        };
      });

      const categories = this.categorizeCars(enrichedCars);

      return {
        categories,
        allCars: enrichedCars,
        total: enrichedCars.length,
      };
    } catch (error) {
      if (error instanceof CarException) {
        throw error;
      }
      this.logger.error("Failed to fetch categorized cars", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new CarFetchFailedException();
    }
  }
}
