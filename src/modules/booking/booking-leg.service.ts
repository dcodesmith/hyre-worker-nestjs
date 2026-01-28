import { Injectable } from "@nestjs/common";
import { UTCDate } from "@date-fns/utc";
import { addDays, addHours, eachDayOfInterval, setHours, setMinutes, setSeconds } from "date-fns";
import {
  AIRPORT_PICKUP_BUFFER_MINUTES,
  AIRPORT_PICKUP_DRIVE_TIME_MULTIPLIER,
  DAY_BOOKING_DURATION_HOURS,
  FULL_DAY_DURATION_HOURS,
  NIGHT_END_HOUR,
  NIGHT_START_HOUR,
} from "./booking.const";
import { GeneratedLeg, LegGenerationInput } from "./booking.interface";

/**
 * Service for generating booking legs for different booking types.
 *
 * This service handles:
 * - DAY bookings: 12-hour legs based on pickup time, one per calendar day
 * - NIGHT bookings: 23:00 - 05:00 legs, one per night
 * - FULL_DAY bookings: 24-hour periods from pickup time
 * - AIRPORT_PICKUP bookings: Single leg based on flight arrival + buffer
 */
@Injectable()
export class BookingLegService {
  /**
   * Generate booking legs based on booking type.
   *
   * @param input - Leg generation parameters
   * @returns Array of generated legs
   * @throws Error if required parameters are missing for the booking type
   */
  generateLegs(input: LegGenerationInput): GeneratedLeg[] {
    const { bookingType } = input;

    switch (bookingType) {
      case "DAY":
        return this.generateDayLegs(input);
      case "NIGHT":
        return this.generateNightLegs(input);
      case "FULL_DAY":
        return this.generateFullDayLegs(input);
      case "AIRPORT_PICKUP":
        return this.generateAirportPickupLegs(input);
      default: {
        const exhaustiveCheck: never = bookingType;
        throw new Error(`Unknown booking type: ${exhaustiveCheck}`);
      }
    }
  }

  /**
   * Generate legs for DAY bookings.
   *
   * DAY bookings have:
   * - One leg per calendar day in the date range
   * - 12-hour duration starting at the pickup time hour
   * - Example: 9 AM pickup → 9 AM - 9 PM
   *
   * @param input - DAY leg input (pickupTime guaranteed by discriminated union)
   * @returns Array of 12-hour legs, one per day
   */
  private generateDayLegs(
    input: Extract<LegGenerationInput, { bookingType: "DAY" }>,
  ): GeneratedLeg[] {
    const { startDate, endDate, pickupTime } = input;

    const { hours, minutes } = this.parsePickupTime(pickupTime);
    const effectiveEndDate = this.getEffectiveEndDate(endDate, startDate);

    // Convert to UTCDate for timezone-safe operations
    const utcStart = new UTCDate(startDate);
    const utcEnd = new UTCDate(effectiveEndDate);

    const days = eachDayOfInterval({ start: utcStart, end: utcEnd });

    return days.map((day) => {
      const legStartTime = setSeconds(setMinutes(setHours(day, hours), minutes), 0);
      const legEndTime = addHours(legStartTime, DAY_BOOKING_DURATION_HOURS);

      return {
        legDate: day,
        legStartTime,
        legEndTime,
      };
    });
  }

  /**
   * Generate legs for NIGHT bookings.
   *
   * NIGHT bookings have:
   * - Fixed hours: 23:00 (11 PM) to 05:00 (5 AM next day)
   * - One leg per night in the date range
   * - Number of nights = ceil((endDate - startDate) / 24 hours)
   *
   * @param input - NIGHT leg input
   * @returns Array of 6-hour legs from 11 PM to 5 AM
   */
  private generateNightLegs(
    input: Extract<LegGenerationInput, { bookingType: "NIGHT" }>,
  ): GeneratedLeg[] {
    const { startDate, endDate } = input;
    const effectiveEndDate = this.getEffectiveEndDate(endDate, startDate);

    const legs: GeneratedLeg[] = [];
    const totalHours = (effectiveEndDate.getTime() - startDate.getTime()) / (1000 * 60 * 60);
    const numberOfNights = Math.max(1, Math.ceil(totalHours / 24));

    // Convert to UTCDate for timezone-safe operations
    const utcStart = new UTCDate(startDate);

    for (let i = 0; i < numberOfNights; i++) {
      const nightDate = addDays(utcStart, i);

      // Leg starts at 11 PM on the night date (UTC)
      const legStartTime = setSeconds(setMinutes(setHours(nightDate, NIGHT_START_HOUR), 0), 0);

      // Leg ends at 5 AM the next day (UTC)
      const nextDay = addDays(nightDate, 1);
      const legEndTime = setSeconds(setMinutes(setHours(nextDay, NIGHT_END_HOUR), 0), 0);

      legs.push({
        legDate: nightDate,
        legStartTime,
        legEndTime,
      });
    }

    return legs;
  }

  /**
   * Generate legs for FULL_DAY bookings.
   *
   * FULL_DAY bookings have:
   * - 24-hour periods starting from pickup time
   * - Number of legs = ceil(totalHours / 24)
   * - Each leg is exactly 24 hours
   *
   * @param input - FULL_DAY leg input (pickupTime guaranteed by discriminated union)
   * @returns Array of 24-hour legs
   */
  private generateFullDayLegs(
    input: Extract<LegGenerationInput, { bookingType: "FULL_DAY" }>,
  ): GeneratedLeg[] {
    const { startDate, endDate, pickupTime } = input;

    const { hours, minutes } = this.parsePickupTime(pickupTime);
    const effectiveEndDate = this.getEffectiveEndDate(endDate, startDate);

    // Convert to UTCDate for timezone-safe operations
    const utcStart = new UTCDate(startDate);

    // Calculate base start time on the start date (UTC)
    const baseStartTime = setSeconds(setMinutes(setHours(utcStart, hours), minutes), 0);

    // Calculate total hours and number of legs
    const totalMs = effectiveEndDate.getTime() - baseStartTime.getTime();
    const totalHours = totalMs / (1000 * 60 * 60);
    const numberOfLegs = Math.max(1, Math.ceil(totalHours / FULL_DAY_DURATION_HOURS));

    const legs: GeneratedLeg[] = [];

    for (let i = 0; i < numberOfLegs; i++) {
      const legStartTime = addHours(baseStartTime, i * FULL_DAY_DURATION_HOURS);
      const legEndTime = addHours(legStartTime, FULL_DAY_DURATION_HOURS);

      legs.push({
        legDate: legStartTime, // Use the actual start time as the leg date
        legStartTime,
        legEndTime,
      });
    }

    return legs;
  }

  /**
   * Generate leg for AIRPORT_PICKUP bookings.
   *
   * AIRPORT_PICKUP bookings have:
   * - Single leg
   * - Start: flight arrival time + 40-minute buffer
   * - End: start time + (drive time × 1.2 buffer)
   * - Preserves exact minutes from flight arrival
   *
   * @param input - AIRPORT_PICKUP leg input
   * @returns Single-element array with the airport pickup leg
   */
  private generateAirportPickupLegs(
    input: Extract<LegGenerationInput, { bookingType: "AIRPORT_PICKUP" }>,
  ): GeneratedLeg[] {
    const { startDate, flightArrivalTime, driveTimeMinutes } = input;

    // If flight arrival time is provided, use it for precise timing
    // Otherwise, use startDate as a fallback (should already have buffer applied)
    const baseTime = flightArrivalTime ?? startDate;

    // Add 40-minute buffer after flight arrival
    const legStartTime = new Date(baseTime.getTime() + AIRPORT_PICKUP_BUFFER_MINUTES * 60 * 1000);

    // Calculate end time based on drive time with 20% buffer
    // Default to 2 hours if drive time is not provided
    const effectiveDriveTime = driveTimeMinutes ?? 120;
    const bufferedDriveTimeMs =
      effectiveDriveTime * AIRPORT_PICKUP_DRIVE_TIME_MULTIPLIER * 60 * 1000;
    const legEndTime = new Date(legStartTime.getTime() + bufferedDriveTimeMs);

    return [
      {
        legDate: startDate,
        legStartTime,
        legEndTime,
      },
    ];
  }

  /**
   * Parse pickup time string into hours and minutes.
   *
   * **Note:** This method assumes pickupTime has been validated by the DTO.
   * The DTO ensures the format matches: H:MM AM/PM (e.g., "9 AM", "9:30 PM")
   *
   * @param pickupTime - Pre-validated time string in H:MM AM/PM format
   * @returns Object with hours (0-23) and minutes (0-59)
   */
  private parsePickupTime(pickupTime: string): { hours: number; minutes: number } {
    const match = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i.exec(pickupTime.trim());

    const [, hourStr, minuteStr, period] = match;
    let hours = Number.parseInt(hourStr, 10);
    const minutes = minuteStr ? Number.parseInt(minuteStr, 10) : 0;
    const isPM = period.toUpperCase() === "PM";

    // Convert to 24-hour format
    if (isPM && hours !== 12) {
      hours += 12;
    } else if (!isPM && hours === 12) {
      hours = 0; // 12 AM is midnight (00:00)
    }

    return { hours, minutes };
  }

  /**
   * Get effective end date for leg generation.
   *
   * If endDate is exactly UTC midnight (00:00:00.000Z), subtract 1ms
   * to avoid off-by-one errors in day boundary calculations.
   * However, never return a date earlier than startDate to avoid
   * invalid intervals that would crash eachDayOfInterval.
   *
   * Note: Uses UTC methods to ensure consistent behavior regardless of
   * server timezone (e.g., Africa/Lagos).
   *
   * @param endDate - Original end date
   * @param startDate - Start date to use as minimum bound
   * @returns Adjusted end date (never earlier than startDate)
   */
  private getEffectiveEndDate(endDate: Date, startDate: Date): Date {
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
}
