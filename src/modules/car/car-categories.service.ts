import { Injectable } from "@nestjs/common";
import { CarApprovalStatus, Status } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
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
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly carPromotionEnrichmentService: CarPromotionEnrichmentService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CarCategoriesService.name);
  }

  /**
   * Categorizes cars into meaningful groups for display.
   * Returns an array of categories with name, title, type, and cars.
   * Only includes categories that meet the minimum size threshold.
   */
  private categorizeCars(cars: PublicCarDto[]): CarCategory[] {
    const buckets = Object.fromEntries(
      CATEGORY_DEFINITIONS.map(({ name }) => [name, [] as PublicCarDto[]]),
    ) as Record<CategoryName, PublicCarDto[]>;

    for (const car of cars) {
      for (const { name, matcher } of CATEGORY_DEFINITIONS) {
        if (matcher(car)) {
          buckets[name].push(car);
        }
      }
    }

    // Build result array, only including categories that meet minimum size
    return CATEGORY_DEFINITIONS.filter(({ name }) => buckets[name].length >= MIN_CATEGORY_SIZE).map(
      ({ name, title, type }) => ({
        name,
        title,
        type,
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

      const carsWithPromotion = await this.carPromotionEnrichmentService.enrichCarsWithPromotion({
        cars,
        referenceDate: query.from ?? new Date(),
        failureMessage:
          "Promotion enrichment failed for categorized cars; returning cars without promotions",
      });

      const enrichedCars = carsWithPromotion.map(({ ownerId: _ownerId, ...car }) => car);

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

      this.logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to fetch categorized cars",
      );
      throw new CarFetchFailedException();
    }
  }
}
