import { formatInTimeZone } from "date-fns-tz";

const AIRPORT_BOOKING_BUFFER_MINUTES = 40;
const OPERATIONS_TIME_ZONE = "Africa/Lagos";

export function calculatePickupActivationTime(expectedArrival: Date | null): Date | null {
  return expectedArrival
    ? new Date(expectedArrival.getTime() + AIRPORT_BOOKING_BUFFER_MINUTES * 60 * 1000)
    : null;
}

export function formatFlightOperationalTime(value: Date | null): string {
  return value
    ? formatInTimeZone(value, OPERATIONS_TIME_ZONE, "d MMM yyyy, h:mm a zzz")
    : "Not currently available";
}

export function buildFlightArrivalLocation(
  destination: string,
  terminal?: string | null,
  gate?: string | null,
): string {
  return [destination, terminal ? `Terminal ${terminal}` : null, gate ? `Gate ${gate}` : null]
    .filter(Boolean)
    .join(", ");
}
