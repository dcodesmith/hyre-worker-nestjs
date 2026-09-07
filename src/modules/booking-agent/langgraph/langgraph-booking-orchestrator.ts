import {
  getDefaultPickupTime,
  normalizeBookingTimeWindow,
  toApiPickupTime,
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
      pickupTime: toApiPickupTime(pickupTime),
      flightNumber: draft.flightNumber,
      includeSecurityDetail: false,
      requiresFullTank: false,
      useCredits: 0,
      // Placeholder required by CreateBookingInput. CreateBookingNode replaces it
      // with the authoritative pricing-preview total before creating the booking.
      expectedTotalAmount: selectedOption.estimatedTotalInclVat.toString(),
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
