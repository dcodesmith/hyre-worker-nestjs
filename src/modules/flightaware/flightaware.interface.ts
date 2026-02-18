import { FlightStatus } from "@prisma/client";

/**
 * FlightAware API Types and Interfaces
 */

/**
 * Validated flight information returned from FlightAware
 */
export interface ValidatedFlight {
  flightNumber: string;
  flightId: string;
  origin: string;
  originIATA?: string;
  /** Origin airport name (e.g., "London Heathrow") */
  originName?: string;
  destination: string;
  destinationIATA?: string;
  /** Destination airport name (e.g., "Murtala Muhammed International Airport") */
  destinationName?: string;
  /** Destination city (e.g., "Lagos") */
  destinationCity?: string;
  scheduledArrival: string;
  estimatedArrival?: string;
  actualArrival?: string;
  status?: string;
  aircraftType?: string;
  delay?: number;
  /** True if from real-time API, false if from schedules */
  isLive?: boolean;
}

/**
 * FlightAware API response for real-time flights endpoint
 */
export interface FlightAwareFlightLeg {
  ident: string;
  fa_flight_id: string;
  actual_off?: string;
  actual_on?: string;
  estimated_off?: string;
  estimated_on?: string;
  estimated_in?: string;
  scheduled_off: string;
  scheduled_on: string;
  origin: {
    code: string;
    code_iata?: string;
    name?: string;
  };
  destination: {
    code: string;
    code_iata?: string;
    name?: string;
    city?: string;
  };
  aircraft_type?: string;
  status?: string;
  delay?: number;
}

export interface FlightAwareResponse {
  flights: FlightAwareFlightLeg[];
  num_pages?: number;
}

/**
 * FlightAware API response for schedules endpoint
 */
export interface FlightAwareScheduledFlight {
  ident: string;
  ident_iata?: string | null;
  ident_icao?: string | null;
  actual_ident?: string | null;
  actual_ident_iata?: string | null;
  fa_flight_id?: string | null;
  operator?: string | null;
  operator_iata?: string | null;
  flight_number?: string | null;
  origin: string;
  origin_iata?: string | null;
  destination: string;
  destination_iata?: string | null;
  scheduled_out: string;
  scheduled_in: string;
  scheduled_off?: string | null;
  scheduled_on?: string | null;
  estimated_in?: string | null;
  actual_out?: string | null;
  actual_in?: string | null;
  aircraft_type?: string | null;
}

export interface FlightAwareSchedulesResponse {
  scheduled: FlightAwareScheduledFlight[];
  num_pages?: number;
  links?: string | null;
}

/**
 * FlightAware alert response
 */
export interface FlightAwareAlertResponse {
  alert_id: string;
  ident: string;
  enabled: boolean;
  events: string[];
  created_at: string;
}

/**
 * Parameters for creating a flight alert
 */
export interface CreateAlertParams {
  flightNumber: string;
  flightDate: Date;
  destinationIATA?: string;
  events?: string[];
}

export type SearchFlightResult =
  | { flight: null; message: string }
  | { flight: ValidatedFlight; warning?: string };

export type FlightAwareWebhookResult = {
  duplicate: boolean;
  flightId: string;
  bookingCount: number;
  newStatus: FlightStatus;
};

export type apEventTypeToStatus = {
  eventType: string;
  flightStatus?: string;
  flightId?: string;
  callSign?: string;
  eventTime?: Date;
};
