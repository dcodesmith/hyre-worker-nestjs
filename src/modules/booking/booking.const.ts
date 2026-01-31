import { Decimal } from "@prisma/client/runtime/library";

/**
 * Buffer time in hours between bookings for car preparation/turnaround.
 * This extends existing booking windows by 2 hours on each side.
 */
export const BOOKING_BUFFER_HOURS = 2;

/**
 * Cutoff hour for same-day DAY bookings (11 AM Lagos time).
 * Same-day DAY bookings are not allowed at or after this hour.
 */
export const SAME_DAY_BOOKING_CUTOFF_HOUR = 11;

/**
 * Minimum advance notice required for airport pickup bookings (in milliseconds).
 * Airport pickups require at least 1 hour advance notice.
 */
export const AIRPORT_PICKUP_MIN_ADVANCE_MS = 60 * 60 * 1000; // 1 hour

/**
 * Tolerance for price validation between client and server amounts.
 * Allows for minor rounding differences in Decimal calculations.
 */
export const PRICE_TOLERANCE = new Decimal("0.01");

/**
 * Constants for leg generation
 */
export const DAY_BOOKING_DURATION_HOURS = 12;
export const NIGHT_START_HOUR = 23; // 11 PM
export const NIGHT_END_HOUR = 5; // 5 AM
export const FULL_DAY_DURATION_HOURS = 24;
export const AIRPORT_PICKUP_BUFFER_MINUTES = 40;
export const AIRPORT_PICKUP_DRIVE_TIME_MULTIPLIER = 1.2;

/** Maximum number of legs eligible for fuel upgrade */
export const MAX_LEGS_FOR_FUEL_UPGRADE = 2;
