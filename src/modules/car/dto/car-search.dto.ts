import { BookingType, ServiceTier, VehicleType } from "@prisma/client";
import { z } from "zod";

/**
 * Mapping of free-text queries to vehicle types
 */
export const VEHICLE_TYPE_LABELS: Record<VehicleType, string> = {
  SEDAN: "Sedan",
  SUV: "SUV",
  LUXURY_SEDAN: "Luxury Sedan",
  LUXURY_SUV: "Luxury SUV",
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

/**
 * Query parameters schema for car search endpoint
 */
export const carSearchQuerySchema = z.object({
  // Free-text search query (maps to vehicleType/serviceTier or make/model)
  q: z.string().optional(),

  // Direct filters
  serviceTier: z.enum(Object.values(ServiceTier) as [ServiceTier, ...ServiceTier[]]).optional(),
  vehicleType: z.enum(Object.values(VehicleType) as [VehicleType, ...VehicleType[]]).optional(),
  color: z.string().optional(),
  make: z.string().optional(),
  model: z.string().optional(),

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

  // Pagination
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(12),
});

export type CarSearchQueryDto = z.infer<typeof carSearchQuerySchema>;

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
  serviceTier: ServiceTier | null;
  vehicleType: VehicleType | null;
  bookingType: BookingType | null;
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

  // Prioritize exact matches first
  for (const [type, label] of Object.entries(VEHICLE_TYPE_LABELS)) {
    if (normalizedQuery === label.toLowerCase() || normalizedQuery === type.toLowerCase()) {
      return { vehicleType: type as VehicleType };
    }
  }

  for (const [tier, label] of Object.entries(SERVICE_TIER_LABELS)) {
    if (normalizedQuery === label.toLowerCase() || normalizedQuery === tier.toLowerCase()) {
      return { serviceTier: tier as ServiceTier };
    }
  }

  // Then try partial matches (only for queries with 3+ characters)
  if (normalizedQuery.length < 3) {
    return { remainingQuery };
  }

  // Track matched terms to extract them from the query
  let matchedVehicleType: VehicleType | undefined;
  let matchedServiceTier: ServiceTier | undefined;
  let matchedLabel: string | undefined;

  for (const [type, label] of Object.entries(VEHICLE_TYPE_LABELS)) {
    if (
      normalizedQuery.includes(label.toLowerCase()) ||
      label.toLowerCase().includes(normalizedQuery)
    ) {
      matchedVehicleType = type as VehicleType;
      matchedLabel = label;
      break;
    }
  }

  // Try to match service tiers (only if no vehicle type was matched)
  if (!matchedVehicleType) {
    for (const [tier, label] of Object.entries(SERVICE_TIER_LABELS)) {
      if (
        normalizedQuery.includes(label.toLowerCase()) ||
        label.toLowerCase().includes(normalizedQuery)
      ) {
        matchedServiceTier = tier as ServiceTier;
        matchedLabel = label;
        break;
      }
    }
  }

  // Extract matched term from query to get remaining text for make/model search
  if (matchedLabel) {
    remainingQuery = remainingQuery.replaceAll(new RegExp(matchedLabel, "gi"), "").trim();
  }

  return {
    vehicleType: matchedVehicleType,
    serviceTier: matchedServiceTier,
    remainingQuery: remainingQuery || undefined,
  };
}
