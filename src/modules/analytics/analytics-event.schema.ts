import { BookingType, ServiceTier, VehicleType } from "@prisma/client";
import { z } from "zod";

export const ANALYTICS_SCHEMA_VERSION = 1;

export const AnalyticsEventType = {
  AVAILABILITY_SEARCH_COMPLETED: "AVAILABILITY_SEARCH_COMPLETED",
  AVAILABILITY_SEARCH_FAILED: "AVAILABILITY_SEARCH_FAILED",
  BOOKING_REQUESTED: "BOOKING_REQUESTED",
} as const;

export const AvailabilitySearchOutcome = {
  MATCHES_FOUND: "MATCHES_FOUND",
  NO_MATCH_FILTERS: "NO_MATCH_FILTERS",
  NO_MATCH_AVAILABILITY: "NO_MATCH_AVAILABILITY",
  NO_MATCH_UNCLASSIFIED: "NO_MATCH_UNCLASSIFIED",
} as const;

export const AnalyticsSource = {
  WEB_CAR_SEARCH: "WEB_CAR_SEARCH",
  WHATSAPP_AGENT: "WHATSAPP_AGENT",
  BOOKING_API: "BOOKING_API",
} as const;

export const ANALYTICS_MARKET = {
  countryCode: "NG",
  marketCode: "LAGOS",
  timezone: "Africa/Lagos",
} as const;

const marketSchema = z
  .object({
    countryCode: z.literal(ANALYTICS_MARKET.countryCode),
    marketCode: z.literal(ANALYTICS_MARKET.marketCode),
    timezone: z.literal(ANALYTICS_MARKET.timezone),
  })
  .strict();

export const availabilitySearchFiltersSchema = z
  .object({
    bookingType: z.enum(Object.values(BookingType) as [BookingType, ...BookingType[]]),
    vehicleTypes: z.array(z.enum(Object.values(VehicleType) as [VehicleType, ...VehicleType[]])),
    serviceTiers: z.array(z.enum(Object.values(ServiceTier) as [ServiceTier, ...ServiceTier[]])),
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    pickupTime: z.string().max(16).nullable(),
    minPrice: z.number().int().nonnegative().nullable(),
    maxPrice: z.number().int().nonnegative().nullable(),
    minCapacity: z.number().int().nonnegative().nullable(),
    fuelIncluded: z.boolean().nullable(),
    dealsOnly: z.boolean().nullable(),
  })
  .strict();

export const availabilitySearchCompletedPayloadSchema = z
  .object({
    filters: availabilitySearchFiltersSchema,
    filterFingerprint: z.string().length(64),
    resultCount: z.number().int().nonnegative(),
    filterMatchCount: z.number().int().nonnegative().nullable(),
    outcome: z.enum(Object.values(AvailabilitySearchOutcome)),
    market: marketSchema,
  })
  .strict();

export const availabilitySearchFailedPayloadSchema = z
  .object({
    filters: availabilitySearchFiltersSchema,
    filterFingerprint: z.string().length(64),
    errorCode: z.literal("SEARCH_EXECUTION_FAILED"),
    market: marketSchema,
  })
  .strict();

export const bookingRequestedPayloadSchema = z
  .object({
    bookingType: z.enum(Object.values(BookingType) as [BookingType, ...BookingType[]]),
    startDate: z.iso.datetime(),
    endDate: z.iso.datetime(),
    carId: z.uuid(),
    vehicleType: z.enum(Object.values(VehicleType) as [VehicleType, ...VehicleType[]]),
    serviceTier: z.enum(Object.values(ServiceTier) as [ServiceTier, ...ServiceTier[]]),
    amount: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/),
    currency: z.literal("NGN"),
    market: marketSchema,
  })
  .strict();
