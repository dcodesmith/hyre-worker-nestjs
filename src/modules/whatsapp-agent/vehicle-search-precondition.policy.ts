import { BookingType } from "@prisma/client";
import type { ExtractedAiSearchParams } from "../ai-search/ai-search.interface";
import type { VehicleSearchPrecondition } from "./whatsapp-agent.interface";

export function parseSearchDate(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

export function normalizeBookingType(value: string | undefined): BookingType | null {
  if (!value) {
    return null;
  }
  if (Object.values(BookingType).includes(value as BookingType)) {
    return value as BookingType;
  }
  return null;
}

export class VehicleSearchPreconditionPolicy {
  private readonly pickupTimePattern = /^(1[0-2]|[1-9])(:[0-5]\d)?\s?(AM|PM)$/i;

  resolve(extracted: ExtractedAiSearchParams): VehicleSearchPrecondition | null {
    const pickupDate = parseSearchDate(extracted.from);
    if (!pickupDate) {
      return {
        missingField: "from",
        prompt: "What date should pickup start? Please share it as YYYY-MM-DD.",
      };
    }
    if (extracted.to) {
      const dropoffDate = parseSearchDate(extracted.to);
      if (!dropoffDate) {
        return {
          missingField: "to",
          prompt: "Please share a valid drop-off date as YYYY-MM-DD.",
        };
      }
      if (dropoffDate.getTime() < pickupDate.getTime()) {
        return {
          missingField: "to",
          prompt: "Drop-off date cannot be before pickup date. Please share a valid drop-off date.",
        };
      }
    }

    if (extracted.pickupTime && !this.pickupTimePattern.test(extracted.pickupTime.trim())) {
      return {
        missingField: "pickupTime",
        prompt: "Please share pickup time in this format: 9:00 AM.",
      };
    }

    const bookingType = normalizeBookingType(extracted.bookingType);
    if (
      (bookingType === BookingType.DAY || bookingType === BookingType.FULL_DAY) &&
      !extracted.pickupTime
    ) {
      return {
        missingField: "pickupTime",
        prompt: "What pickup time should I use? For example, 9:00 AM.",
      };
    }

    if (bookingType === BookingType.AIRPORT_PICKUP && !extracted.flightNumber) {
      return {
        missingField: "flightNumber",
        prompt: "Please share your flight number so I can check airport pickup availability.",
      };
    }

    return null;
  }

  shouldClarifyBookingType(extracted: ExtractedAiSearchParams): boolean {
    const bookingType = normalizeBookingType(extracted.bookingType);
    if (!bookingType) {
      return true;
    }

    if (bookingType !== BookingType.DAY || !extracted.from || !extracted.to) {
      return false;
    }

    const fromDate = parseSearchDate(extracted.from);
    const toDate = parseSearchDate(extracted.to);
    if (!fromDate || !toDate) {
      return false;
    }

    const dayDiff = Math.round((toDate.getTime() - fromDate.getTime()) / (24 * 60 * 60 * 1000));
    // If a multi-day request was auto-normalized to DAY, ask user to confirm DAY vs FULL_DAY.
    return dayDiff >= 1;
  }
}
