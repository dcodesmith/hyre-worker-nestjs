import { formatInTimeZone } from "date-fns-tz";
import { AIRPORT_PICKUP_BUFFER_MINUTES } from "../../booking/booking.const";
import type { BookingDraft } from "./conversation.interface";

const LAGOS_TIMEZONE = "Africa/Lagos";

function formatDriveDuration(minutes: number): string {
  if (minutes < 60) {
    return `${minutes} mins`;
  }

  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours} hour${hours === 1 ? "" : "s"}${remainder ? ` ${remainder} mins` : ""}`;
}

export function buildAirportTripDetailLines(draft: BookingDraft): string[] {
  if (
    draft.bookingType !== "AIRPORT_PICKUP" ||
    !draft.pickupDateTime ||
    !draft.dropoffDateTime ||
    typeof draft.airportDistanceMeters !== "number" ||
    !Number.isFinite(draft.airportDistanceMeters)
  ) {
    return [];
  }

  const pickup = new Date(draft.pickupDateTime);
  const dropoff = new Date(draft.dropoffDateTime);
  if (Number.isNaN(pickup.getTime()) || Number.isNaN(dropoff.getTime()) || dropoff <= pickup) {
    return [];
  }

  const arrival = new Date(pickup.getTime() - AIRPORT_PICKUP_BUFFER_MINUTES * 60_000);
  const driveMinutes = Math.ceil((dropoff.getTime() - pickup.getTime()) / 60_000);
  const time = (value: Date) => formatInTimeZone(value, LAGOS_TIMEZONE, "h:mm aaa");
  const distance =
    draft.airportDistanceMeters > 0
      ? `${(draft.airportDistanceMeters / 1000).toFixed(1)} km`
      : "Distance unavailable";
  const drive = `${formatDriveDuration(driveMinutes)}${
    draft.airportDriveIsEstimate ? " (estimated)" : ""
  }`;

  return [
    `*✈️ Trip Details${draft.flightNumber ? ` — ${draft.flightNumber}` : ""}*`,
    `*Flight Arrival:* ${time(arrival)}`,
    `*Pickup Time:* ${time(pickup)}`,
    `*Estimated Drive:* ${drive}`,
    `*Distance:* ${distance}`,
    `*Estimated Drop-off:* ${time(dropoff)}`,
  ];
}
