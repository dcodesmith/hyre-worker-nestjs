import type { NormalisedBookingLegDetails } from "../types";
import type { TripCardData } from "./booking-email-cards";

export function firstNameFrom(fullName: string): string {
  const trimmed = fullName.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.split(/\s+/)[0] || trimmed;
}

/** Maps a booking leg to the trip card shape (hireApp-style route + totals row). */
export function bookingLegToTripCardData(leg: NormalisedBookingLegDetails): TripCardData {
  return {
    bookingReference: leg.bookingId,
    carName: leg.carName,
    pickupLocation: leg.pickupLocation,
    returnLocation: leg.returnLocation,
    startDate: leg.legStartTime,
    endDate: leg.legEndTime,
    totalAmount: "—",
  };
}
