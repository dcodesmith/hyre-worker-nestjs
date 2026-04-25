import type { BookingType } from "@prisma/client";

export const BOOKING_CONFIRMED_EVENT = "booking.confirmed";
export const FLIGHT_ARRIVAL_UPDATED_EVENT = "flight.arrival-updated";

export interface BookingConfirmedEventPayload {
  bookingId: string;
  bookingType: BookingType;
  activationAt?: string;
}

export interface FlightArrivalUpdatedEventPayload {
  flightId: string;
  activationAt: string;
}
