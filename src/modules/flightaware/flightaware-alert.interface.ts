export interface FlightAlertJobData {
  flightId: string;
  flightNumber: string;
  flightDate: string; // ISO string (Dates are serialised in Redis)
  destinationIATA?: string;
}
