import { ServiceTier, VehicleType } from "@prisma/client";
import { z } from "zod";
import type { CarPromotionDto } from "./car-promotion.dto";

/** Minimum number of cars needed to show a category */
export const MIN_CATEGORY_SIZE = 3;

/**
 * Query parameters for the car categories endpoint
 */
export const carCategoriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  from: z.coerce.date().optional(),
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
  promotion: CarPromotionDto | null;
}

/**
 * Category names as a const array for type safety
 */
export const CATEGORY_NAMES = ["suv", "luxury", "budget", "sedan", "executive", "popular"] as const;

export type CategoryName = (typeof CATEGORY_NAMES)[number];

/**
 * Which field(s) drive this category (for mapping to search filters).
 * `make` is used for brand-based buckets (e.g. popular makes).
 */
export type CarCategoryType = "serviceTier" | "vehicleType" | "make";

/**
 * Category definition with matcher function and display title
 */
export interface CategoryDefinition {
  name: CategoryName;
  title: string;
  /** Dimension this category groups by */
  type: CarCategoryType;
  matcher: (car: PublicCarDto) => boolean;
}

/**
 * Category definitions - single source of truth for categorization logic.
 * To add a new category: add to CATEGORY_NAMES and add a definition here.
 */
export const CATEGORY_DEFINITIONS: CategoryDefinition[] = [
  {
    name: "suv",
    title: "SUV",
    type: "vehicleType",
    matcher: (car) => car.vehicleType === VehicleType.SUV,
  },
  {
    name: "luxury",
    title: "Luxury",
    type: "serviceTier",
    matcher: (car) =>
      car.serviceTier === ServiceTier.LUXURY || car.serviceTier === ServiceTier.ULTRA_LUXURY,
  },
  {
    name: "budget",
    title: "Budget-friendly",
    type: "serviceTier",
    matcher: (car) => car.serviceTier === ServiceTier.STANDARD,
  },
  {
    name: "sedan",
    title: "Sedan",
    type: "vehicleType",
    matcher: (car) => car.vehicleType === VehicleType.SEDAN,
  },
  {
    name: "executive",
    title: "Executive",
    type: "serviceTier",
    matcher: (car) => car.serviceTier === ServiceTier.EXECUTIVE,
  },
  {
    name: "popular",
    title: "Popular",
    type: "make",
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
  type: CarCategoryType;
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
