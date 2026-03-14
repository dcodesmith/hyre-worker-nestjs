import {
  getDefaultPickupTime,
  normalizeBookingTimeWindow,
} from "../../../shared/booking-time-window.helper";
import type { CreateBookingInput } from "../../booking/dto/create-booking.dto";
import type {
  BookingDraft,
  VehicleSearchOption,
  WhatsAppGuestIdentity,
} from "./langgraph.interface";

export function buildGuestIdentity(
  phoneE164: string,
  profileName: string | null,
): WhatsAppGuestIdentity {
  const phoneDigits = stripNonDigits(phoneE164);
  return {
    guestEmail: `whatsapp.${phoneDigits}@tripdly.com`,
    guestName: profileName ?? "WhatsApp Customer",
    guestPhone: phoneE164,
  };
}

export function buildBookingInputFromDraft(
  draft: BookingDraft,
  selectedOption: VehicleSearchOption,
  guestIdentity: WhatsAppGuestIdentity,
): {
  input: CreateBookingInput;
  normalizedStartDate: Date;
  normalizedEndDate: Date;
} {
  const bookingType = draft.bookingType ?? "DAY";
  const pickupTime = draft.pickupTime ?? getDefaultPickupTime(bookingType);

  const { startDate, endDate } = normalizeBookingTimeWindow({
    bookingType,
    startDate: new Date(draft.pickupDate),
    endDate: new Date(draft.dropoffDate),
    pickupTime,
  });

  const sameLocation = draft.pickupLocation === draft.dropoffLocation;

  return {
    input: {
      carId: selectedOption.id,
      startDate,
      endDate,
      pickupAddress: draft.pickupLocation ?? "",
      bookingType,
      pickupTime: normalizePickupTimeTo12Hour(pickupTime),
      flightNumber: draft.flightNumber,
      includeSecurityDetail: false,
      requiresFullTank: false,
      useCredits: 0,
      // Let BookingCreationService compute authoritative totals server-side.
      // Avoid passing estimated totals from search cards, which may be rounded for display.
      guestEmail: guestIdentity.guestEmail,
      guestName: guestIdentity.guestName,
      guestPhone: guestIdentity.guestPhone,
      ...(sameLocation
        ? { sameLocation: true as const }
        : {
            sameLocation: false as const,
            dropOffAddress: draft.dropoffLocation ?? draft.pickupLocation ?? "",
          }),
    },
    normalizedStartDate: startDate,
    normalizedEndDate: endDate,
  };
}

function normalizePickupTimeTo12Hour(pickupTime: string): string {
  if (hasMeridiemSuffix(pickupTime)) {
    return pickupTime;
  }

  const parsed = parse24HourTime(pickupTime);
  if (parsed) {
    return to12HourTime(parsed.hours24, parsed.minutes);
  }

  return pickupTime;
}

function parse24HourTime(value: string): { hours24: number; minutes: number } | null {
  const parts = value.split(":");
  if (parts.length !== 2 || !isAsciiDigits(parts[0], 1, 2) || !isAsciiDigits(parts[1], 2, 2)) {
    return null;
  }

  const hours24 = Number.parseInt(parts[0], 10);
  const minutes = Number.parseInt(parts[1], 10);
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

function hasMeridiemSuffix(value: string): boolean {
  const trimmed = value.trimEnd().toUpperCase();
  return trimmed.endsWith("AM") || trimmed.endsWith("PM");
}

function isAsciiDigits(value: string, minLength: number, maxLength: number): boolean {
  if (value.length < minLength || value.length > maxLength) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.codePointAt(index);
    if (code === undefined) {
      return false;
    }
    if (code < 48 || code > 57) {
      return false;
    }
  }
  return true;
}

function stripNonDigits(value: string): string {
  let digits = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.codePointAt(index);
    if (code === undefined) {
      continue;
    }
    if (code >= 48 && code <= 57) {
      digits += value[index];
    }
  }
  return digits;
}
