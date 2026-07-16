import { BookingType, ServiceTier, VehicleType } from "@prisma/client";
import { z } from "zod";
import type { CarPromotionDto } from "./car-promotion.dto";

/**
 * Mapping of free-text queries to vehicle types
 */
export const VEHICLE_TYPE_LABELS: Record<VehicleType, string> = {
  SEDAN: "Sedan",
  SUV: "SUV",
  VAN: "Van",
  CROSSOVER: "Crossover",
};

/**
 * Mapping of free-text queries to service tiers
 */
export const SERVICE_TIER_LABELS: Record<ServiceTier, string> = {
  STANDARD: "Standard",
  EXECUTIVE: "Executive",
  LUXURY: "Luxury",
  ULTRA_LUXURY: "Ultra Luxury",
};

/**
 * Valid booking types for search
 */
export const BOOKING_TYPES = ["DAY", "NIGHT", "FULL_DAY", "AIRPORT_PICKUP"] as const;

/** Splits a comma-separated query value ("SUV,SEDAN") into a trimmed list. */
const parseCsv = (raw: unknown): unknown =>
  typeof raw === "string"
    ? raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    : raw;

/** URL boolean flag: "1"/"true" → true, absent → undefined (i.e. not filtering). */
const optionalFlag = z.preprocess(
  (value) => (value === undefined ? undefined : value === "1" || value === "true"),
  z.boolean().optional(),
);

/**
 * Query parameters schema for car search endpoint
 */
export const carSearchQuerySchema = z.object({
  // Free-text search query (maps to vehicleType/serviceTier or make/model)
  q: z.string().optional(),

  // Multi-select filters (comma-separated in the URL, e.g. "SUV,SEDAN"). A single
  // value parses as a one-element array, so legacy single-value callers keep working.
  serviceTier: z
    .preprocess(
      parseCsv,
      z.array(z.enum(Object.values(ServiceTier) as [ServiceTier, ...ServiceTier[]])),
    )
    .optional(),
  vehicleType: z
    .preprocess(
      parseCsv,
      z.array(z.enum(Object.values(VehicleType) as [VehicleType, ...VehicleType[]])),
    )
    .optional(),
  make: z.preprocess(parseCsv, z.array(z.string().min(1)).max(20)).optional(),
  color: z.string().optional(),
  model: z.string().optional(),

  // Facet filters
  minPrice: z.coerce.number().int().min(0).optional(),
  maxPrice: z.coerce.number().int().min(0).optional(),
  minCapacity: z.coerce.number().int().min(0).optional(),
  fuelIncluded: optionalFlag,
  dealsOnly: optionalFlag,

  // Date/availability filters (accepts ISO strings like "2024-03-01" and coerces to Date)
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  bookingType: z.enum(Object.values(BookingType) as [BookingType, ...BookingType[]]).optional(),
  // Pickup time: "9 AM", "9:00 AM", "11 PM", "2:30 PM" (matches booking DTO)
  pickupTime: z
    .string()
    .regex(/^(1[0-2]|[1-9])(:[0-5]\d)?\s?(AM|PM)$/i, "Pickup time format: H:MM AM/PM")
    .optional(),
  flightNumber: z.string().optional(),

  // Lightweight count-only mode for the filter panel's live "Show N vehicles"
  countOnly: optionalFlag,

  // Pagination
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(12),
});

export type CarSearchQueryDto = z.infer<typeof carSearchQuerySchema>;

/**
 * Query parameters for public car detail endpoint
 */
export const publicCarDetailQuerySchema = z.object({
  from: z.coerce.date().optional(),
});

export type PublicCarDetailQueryDto = z.infer<typeof publicCarDetailQuerySchema>;

/**
 * Car owner info for search results
 */
export interface CarOwnerDto {
  username: string | null;
  name: string;
}

/**
 * Extended car type for search results (includes more fields than PublicCarDto)
 */
export interface SearchCarDto {
  id: string;
  make: string;
  model: string;
  year: number;
  color: string | null;
  dayRate: number;
  nightRate: number | null;
  fullDayRate: number | null;
  airportPickupRate: number | null;
  passengerCapacity: number;
  pricingIncludesFuel: boolean;
  vehicleType: VehicleType;
  serviceTier: ServiceTier;
  images: { url: string }[];
  owner: CarOwnerDto;
  promotion: CarPromotionDto | null;
}

/**
 * Full car detail for public car detail endpoint
 * Includes hourly rate and fuel upgrade rate for booking calculations
 */
export interface PublicCarDetailDto extends SearchCarDto {
  hourlyRate: number | null;
  fuelUpgradeRate: number | null;
}

/**
 * Applied filters in the response (for client to display active filters)
 */
export interface SearchFiltersDto {
  serviceTiers: ServiceTier[];
  vehicleTypes: VehicleType[];
  bookingType: BookingType | null;
}

/**
 * Facet data for the filter panel: available makes with counts and price bounds
 * for the active booking-type rate field.
 */
export interface SearchFacetsDto {
  makes: { name: string; count: number }[];
  price: { min: number; max: number };
}

/**
 * Pagination metadata
 */
export interface SearchPaginationDto {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

/**
 * Response shape for GET /api/cars/search
 */
export interface CarSearchResponseDto {
  cars: SearchCarDto[];
  filters: SearchFiltersDto;
  facets: SearchFacetsDto | null;
  pagination: SearchPaginationDto;
}

/**
 * Result of mapping a free-text query to filters
 */
export interface MappedQueryFilters {
  vehicleType?: VehicleType;
  serviceTier?: ServiceTier;
  remainingQuery?: string;
}

function findExactEnumMatch<T extends string>(
  normalizedQuery: string,
  labels: Record<T, string>,
): T | undefined {
  for (const [value, label] of Object.entries(labels) as Array<[T, string]>) {
    if (normalizedQuery === label.toLowerCase() || normalizedQuery === value.toLowerCase()) {
      return value;
    }
  }
  return undefined;
}

function findPartialEnumMatch<T extends string>(
  normalizedQuery: string,
  labels: Record<T, string>,
): { value: T; label: string } | undefined {
  for (const [value, label] of Object.entries(labels) as Array<[T, string]>) {
    if (
      normalizedQuery.includes(label.toLowerCase()) ||
      label.toLowerCase().includes(normalizedQuery)
    ) {
      return { value, label };
    }
  }
  return undefined;
}

/**
 * Maps a free-text query to vehicle type or service tier if possible.
 * Returns the matched enum values and the remaining query text for make/model search.
 *
 * @example
 * mapQueryToFilters("Toyota Luxury") // { serviceTier: "LUXURY", remainingQuery: "Toyota" }
 * mapQueryToFilters("SUV") // { vehicleType: "SUV" }
 * mapQueryToFilters("Mercedes") // { remainingQuery: "Mercedes" }
 */
export function mapQueryToFilters(query: string): MappedQueryFilters {
  const normalizedQuery = query.trim().toLowerCase();
  let remainingQuery = query.trim();

  const exactVehicleType = findExactEnumMatch(normalizedQuery, VEHICLE_TYPE_LABELS);
  if (exactVehicleType) {
    return { vehicleType: exactVehicleType };
  }

  const exactServiceTier = findExactEnumMatch(normalizedQuery, SERVICE_TIER_LABELS);
  if (exactServiceTier) {
    return { serviceTier: exactServiceTier };
  }

  // Then try partial matches (only for queries with 3+ characters)
  if (normalizedQuery.length < 3) {
    return { remainingQuery };
  }

  const vehicleMatch = findPartialEnumMatch(normalizedQuery, VEHICLE_TYPE_LABELS);
  const serviceTierMatch = vehicleMatch
    ? undefined
    : findPartialEnumMatch(normalizedQuery, SERVICE_TIER_LABELS);
  const matchedLabel = vehicleMatch?.label ?? serviceTierMatch?.label;

  // Extract matched term from query to get remaining text for make/model search
  if (matchedLabel) {
    remainingQuery = remainingQuery.replaceAll(new RegExp(matchedLabel, "gi"), "").trim();
  }

  return {
    vehicleType: vehicleMatch?.value,
    serviceTier: serviceTierMatch?.value,
    remainingQuery: remainingQuery || undefined,
  };
}
