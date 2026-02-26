import { ServiceTier, VehicleType } from "@prisma/client";
import { z } from "zod";

/** Minimum number of cars needed to show a category */
export const MIN_CATEGORY_SIZE = 3;

/**
 * Query parameters for the car categories endpoint
 */
export const carCategoriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type CarCategoriesQueryDto = z.infer<typeof carCategoriesQuerySchema>;

/**
 * Lightweight car type for public display (optimized for mobile/web)
 * Only includes fields needed by CarCard components
 */
export interface PublicCarDto {
  id: string;
  make: string;
  model: string;
  year: number;
  dayRate: number;
  passengerCapacity: number;
  pricingIncludesFuel: boolean;
  vehicleType: VehicleType;
  serviceTier: ServiceTier;
  images: { url: string }[];
}

/**
 * Category names as a const array for type safety
 */
export const CATEGORY_NAMES = [
  "suvs",
  "luxury",
  "budget",
  "sedans",
  "executive",
  "popular",
] as const;

export type CategoryName = (typeof CATEGORY_NAMES)[number];

/**
 * Category definition with matcher function and display title
 */
export interface CategoryDefinition {
  name: CategoryName;
  title: string;
  matcher: (car: PublicCarDto) => boolean;
}

/**
 * Category definitions - single source of truth for categorization logic.
 * To add a new category: add to CATEGORY_NAMES and add a definition here.
 */
export const CATEGORY_DEFINITIONS: CategoryDefinition[] = [
  {
    name: "suvs",
    title: "SUV",
    matcher: (car) =>
      car.vehicleType === VehicleType.SUV || car.vehicleType === VehicleType.LUXURY_SUV,
  },
  {
    name: "luxury",
    title: "Luxury",
    matcher: (car) =>
      car.serviceTier === ServiceTier.LUXURY || car.serviceTier === ServiceTier.ULTRA_LUXURY,
  },
  {
    name: "budget",
    title: "Budget-friendly",
    matcher: (car) => car.serviceTier === ServiceTier.STANDARD,
  },
  {
    name: "sedans",
    title: "Sedans",
    matcher: (car) =>
      car.vehicleType === VehicleType.SEDAN || car.vehicleType === VehicleType.LUXURY_SEDAN,
  },
  {
    name: "executive",
    title: "Executive",
    matcher: (car) => car.serviceTier === ServiceTier.EXECUTIVE,
  },
  {
    name: "popular",
    title: "Popular",
    matcher: (car) => {
      const popularMakes = new Set(["toyota", "honda", "lexus"]);
      return popularMakes.has(car.make.toLowerCase());
    },
  },
];

/**
 * Single category in the response array
 */
export interface CarCategory {
  name: CategoryName;
  title: string;
  cars: PublicCarDto[];
}

/**
 * Response shape for GET /api/cars/categories
 */
export interface CarCategoriesResponseDto {
  categories: CarCategory[];
  allCars: PublicCarDto[];
  total: number;
}
