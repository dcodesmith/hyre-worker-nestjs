import type { NormalisedBookingLegDetails } from "../types";
import type { TripCardData } from "./booking-email-cards";

export function firstNameFrom(fullName: string): string {
  return fullName.split(" ")[0] || fullName;
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
