import type { BookingType } from "@prisma/client";
import type { Decimal } from "@prisma/client/runtime/library";
import type { CarPricing } from "./booking-calculation.interface";

/**
 * Car data with pricing for booking creation.
 */
export interface CarWithPricing extends CarPricing {
  id: string;
}

/**
 * Result from referral eligibility check
 */
export interface ReferralEligibility {
  eligible: boolean;
  referrerUserId: string | null;
  discountAmount: Decimal;
}

/**
 * Flight data needed for booking creation
 */
export interface FlightDataForBooking {
  flightId: string;
  arrivalTime: Date;
  flightNumber: string;
  /** Origin airport ICAO code (e.g., "EGLL") */
  originCode: string | undefined;
  /** Origin airport IATA code (e.g., "LHR") */
  originCodeIATA: string | undefined;
  /** Origin airport name (e.g., "London Heathrow") */
  originName: string | undefined;
  /** Destination airport ICAO code (e.g., "DNMM") */
  destinationCode: string | undefined;
  /** Destination airport IATA code (e.g., "LOS") */
  destinationIATA: string | undefined;
  /** Destination airport name (e.g., "Murtala Muhammed International Airport") */
  destinationName: string | undefined;
  /** Destination city (e.g., "Lagos") */
  destinationCity: string | undefined;
  /** Drive time from airport to drop-off location in minutes */
  driveTimeMinutes?: number;
}

/**
 * Customer details for payment intent
 */
export interface CustomerDetails {
  email: string;
  name: string;
  phoneNumber: string | undefined;
}

export interface CreateBookingResponse {
  bookingId: string;
  checkoutUrl: string;
}

// export type Booking = Prisma.BookingGetPayload<null>;

/**
 * Booking availability check result
 */
export interface CarAvailabilityResult {
  available: boolean;
  conflictingBookings?: Array<{
    id: string;
    startDate: Date;
    endDate: Date;
  }>;
}

export interface DateValidationInput {
  startDate: Date;
  endDate: Date;
  bookingType: BookingType;
}

export interface CarAvailabilityInput {
  carId: string;
  startDate: Date;
  endDate: Date;
  excludeBookingId?: string;
}

export interface GeneratedLeg {
  legDate: Date;
  legStartTime: Date;
  legEndTime: Date;
}

/**
 * Base fields shared by all leg generation inputs
 */
interface BaseLegInput {
  startDate: Date;
  endDate: Date;
}

/**
 * DAY booking leg input - requires pickupTime
 */
interface DayLegInput extends BaseLegInput {
  bookingType: "DAY";
  pickupTime: string;
}

/**
 * NIGHT booking leg input - fixed 23:00-05:00, no pickupTime needed
 */
interface NightLegInput extends BaseLegInput {
  bookingType: "NIGHT";
}

/**
 * FULL_DAY booking leg input - requires pickupTime
 */
interface FullDayLegInput extends BaseLegInput {
  bookingType: "FULL_DAY";
  pickupTime: string;
}

/**
 * AIRPORT_PICKUP booking leg input - optional flight arrival and drive time
 */
interface AirportPickupLegInput extends BaseLegInput {
  bookingType: "AIRPORT_PICKUP";
  flightArrivalTime?: Date;
  driveTimeMinutes?: number;
}

/**
 * Discriminated union for leg generation input.
 * TypeScript will enforce that:
 * - DAY and FULL_DAY require pickupTime
 * - NIGHT requires no additional fields
 * - AIRPORT_PICKUP optionally accepts flightArrivalTime and driveTimeMinutes
 */
export type LegGenerationInput =
  | DayLegInput
  | NightLegInput
  | FullDayLegInput
  | AirportPickupLegInput;
