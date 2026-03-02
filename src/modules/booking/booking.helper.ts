import { UTCDate } from "@date-fns/utc";
import type { BookingType } from "@prisma/client";
import { eachDayOfInterval } from "date-fns";

/**
 * Calculate the number of legs for a booking based on booking type and date range.
 *
 * This is the single source of truth for leg count calculation, used by:
 * - BookingLegService (for actual leg generation)
 * - BookingAgentSearchService (for price estimation)
 *
 * The calculation matches the server's leg generation logic exactly to prevent
 * price mismatches between estimates and actual booking creation.
 *
 * @param bookingType - Type of booking (DAY, NIGHT, FULL_DAY, AIRPORT_PICKUP)
 * @param startDate - Start date of the booking
 * @param endDate - End date of the booking
 * @returns Number of legs for the booking
 */
export function calculateLegCount(
  bookingType: BookingType,
  startDate: Date,
  endDate: Date,
): number {
  switch (bookingType) {
    case "AIRPORT_PICKUP":
      return 1;

    case "DAY":
      return calculateDayLegCount(startDate, endDate);

    case "NIGHT":
      return calculateNightLegCount(startDate, endDate);

    case "FULL_DAY":
      return calculateFullDayLegCount(startDate, endDate);

    default: {
      const exhaustiveCheck: never = bookingType;
      throw new Error(`Unknown booking type: ${exhaustiveCheck}`);
    }
  }
}

/**
 * Calculate leg count for DAY bookings.
 * Uses eachDayOfInterval with UTC dates for consistent results.
 */
function calculateDayLegCount(startDate: Date, endDate: Date): number {
  const effectiveEndDate = getEffectiveEndDate(endDate, startDate);
  const utcStart = new UTCDate(startDate);
  const utcEnd = new UTCDate(effectiveEndDate);

  const days = eachDayOfInterval({ start: utcStart, end: utcEnd });
  return days.length;
}

/**
 * Calculate leg count for NIGHT bookings.
 * Number of nights = ceil(totalHours / 24), minimum 1.
 */
function calculateNightLegCount(startDate: Date, endDate: Date): number {
  const effectiveEndDate = getEffectiveEndDate(endDate, startDate);
  const totalHours = (effectiveEndDate.getTime() - startDate.getTime()) / (1000 * 60 * 60);
  return Math.max(1, Math.ceil(totalHours / 24));
}

/**
 * Calculate leg count for FULL_DAY bookings.
 * Number of legs = ceil(totalHours / 24), minimum 1.
 */
function calculateFullDayLegCount(startDate: Date, endDate: Date): number {
  const effectiveEndDate = getEffectiveEndDate(endDate, startDate);
  const totalMs = effectiveEndDate.getTime() - startDate.getTime();
  const totalHours = totalMs / (1000 * 60 * 60);
  return Math.max(1, Math.ceil(totalHours / 24));
}

/**
 * Get effective end date for leg calculation.
 *
 * If endDate is exactly UTC midnight (00:00:00.000Z), subtract 1ms
 * to avoid off-by-one errors in day boundary calculations.
 * However, never return a date earlier than startDate.
 *
 * @param endDate - Original end date
 * @param startDate - Start date to use as minimum bound
 * @returns Adjusted end date (never earlier than startDate)
 */
export function getEffectiveEndDate(endDate: Date, startDate: Date): Date {
  const isMidnight =
    endDate.getUTCHours() === 0 &&
    endDate.getUTCMinutes() === 0 &&
    endDate.getUTCSeconds() === 0 &&
    endDate.getUTCMilliseconds() === 0;

  if (isMidnight) {
    const adjusted = new Date(endDate.getTime() - 1);
    // Don't adjust if it would make end date earlier than start date
    if (adjusted < startDate) {
      return startDate;
    }
    return adjusted;
  }

  return endDate;
}
