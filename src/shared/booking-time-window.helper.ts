import type { BookingType } from "@prisma/client";
import { addHours, differenceInCalendarDays } from "date-fns";

type NormalizationInput = {
  bookingType: BookingType;
  startDate: Date;
  endDate: Date;
  pickupTime?: string;
};

export function normalizeBookingTimeWindow(input: NormalizationInput): {
  startDate: Date;
  endDate: Date;
} {
  const startDate = new Date(input.startDate);
  const endDate = new Date(input.endDate);
  const pickupTime = input.pickupTime ?? getDefaultPickupTime(input.bookingType);

  switch (input.bookingType) {
    case "AIRPORT_PICKUP":
      return { startDate, endDate };
    case "NIGHT":
      startDate.setHours(23, 0, 0, 0);
      endDate.setHours(5, 0, 0, 0);
      if (endDate.getTime() <= startDate.getTime()) {
        endDate.setDate(endDate.getDate() + 1);
      }
      return { startDate, endDate };
    case "FULL_DAY": {
      parseAndApplyPickupTime(startDate, pickupTime);
      const daySpan = Math.max(1, differenceInCalendarDays(endDate, input.startDate));
      return { startDate, endDate: addHours(startDate, 24 * daySpan) };
    }
    default: {
      parseAndApplyPickupTime(startDate, pickupTime);
      const adjustedEndDate = new Date(endDate);
      adjustedEndDate.setHours(startDate.getHours() + 12, startDate.getMinutes(), 0, 0);
      return { startDate, endDate: adjustedEndDate };
    }
  }
}

export function getDefaultPickupTime(bookingType: BookingType): string {
  switch (bookingType) {
    case "DAY":
      return "7:00 AM";
    case "FULL_DAY":
      return "6:00 AM";
    default:
      return "9:00 AM";
  }
}

/** Convert extractor 24h times to the H[:MM] AM/PM format public booking/search DTOs require. */
export function toApiPickupTime(pickupTime: string): string {
  const trimmed = pickupTime.trim();
  if (API_PICKUP_TIME_PATTERN.test(trimmed)) {
    return trimmed;
  }

  const parsed = parse24HourTime(trimmed);
  if (!parsed) {
    return trimmed;
  }

  return to12HourTime(parsed.hours24, parsed.minutes);
}

const API_PICKUP_TIME_PATTERN = /^(1[0-2]|[1-9])(:[0-5]\d)?\s?(AM|PM)$/i;

function parse24HourTime(value: string): { hours24: number; minutes: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }

  const hours24 = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (hours24 < 0 || hours24 > 23 || minutes < 0 || minutes > 59) {
    return null;
  }

  return { hours24, minutes };
}

function to12HourTime(hours24: number, minutes: number): string {
  let hours12 = hours24;
  const period = hours24 >= 12 ? "PM" : "AM";
  if (hours12 === 0) {
    hours12 = 12;
  } else if (hours12 > 12) {
    hours12 -= 12;
  }

  const minuteStr = minutes > 0 ? `:${minutes.toString().padStart(2, "0")}` : "";
  return `${hours12}${minuteStr} ${period}`;
}

function parseAndApplyPickupTime(date: Date, pickupTime: string): void {
  const time24Match = /^(\d{1,2}):(\d{2})$/.exec(pickupTime);
  if (time24Match) {
    const hours = Number.parseInt(time24Match[1], 10);
    const minutes = Number.parseInt(time24Match[2], 10);
    date.setHours(hours, minutes, 0, 0);
    return;
  }

  const time12Match = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i.exec(pickupTime);
  if (time12Match) {
    let hours = Number.parseInt(time12Match[1], 10);
    const minutes = time12Match[2] ? Number.parseInt(time12Match[2], 10) : 0;
    const period = time12Match[3].toUpperCase();

    if (period === "PM" && hours !== 12) hours += 12;
    if (period === "AM" && hours === 12) hours = 0;

    date.setHours(hours, minutes, 0, 0);
  }
}
