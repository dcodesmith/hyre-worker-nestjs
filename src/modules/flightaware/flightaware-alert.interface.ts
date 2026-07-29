export interface FlightAlertJobData {
  flightId: string;
  flightNumber: string;
  departureTime: string; // ISO string (Dates are serialised in Redis)
  originCode?: string;
  originTimezone?: string;
  destinationIATA?: string;
}
