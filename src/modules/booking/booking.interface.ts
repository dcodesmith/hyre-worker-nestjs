import type { BookingStatus, BookingType, Prisma } from "@prisma/client";

export interface CreateBookingResponse {
  bookingId: string;
  bookingReference: string;
  checkoutUrl: string;
  totalAmount: string;
  status: BookingStatus;
}

export type BookingApiResponse = Prisma.BookingGetPayload<{
  include: {
    car: {
      select: {
        id: true;
        make: true;
        model: true;
        year: true;
        plateNumber: true;
        primaryImageUrl: true;
      };
    };
    user: {
      select: {
        id: true;
        name: true;
        email: true;
      };
    };
    legs: true;
  };
}>;

/**
 * Booking financial breakdown for display (all amounts as strings for Decimal precision)
 */
export interface BookingFinancialsResponse {
  netTotal: string;
  securityDetailCost: string;
  fuelUpgradeCost: string;
  netTotalWithAddons: string;
  platformCustomerServiceFeeRatePercent: string;
  platformCustomerServiceFeeAmount: string;
  subtotalBeforeDiscounts: string;
  referralDiscountAmount: string;
  creditsUsed: string;
  subtotalAfterDiscounts: string;
  vatRatePercent: string;
  vatAmount: string;
  totalAmount: string;
  numberOfLegs: number;
  legPrices: Array<{
    legDate: string;
    price: string;
  }>;
}

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

export interface ValidationError {
  field: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
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
