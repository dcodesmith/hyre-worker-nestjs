import {
  ACTIVATE_AIRPORT_BOOKING,
  ACTIVE_TO_COMPLETED,
  CONFIRMED_TO_ACTIVE,
} from "../../config/constants";

type HourlyStatusUpdateType = typeof CONFIRMED_TO_ACTIVE | typeof ACTIVE_TO_COMPLETED;

export type HourlyStatusUpdateJobData = {
  type: HourlyStatusUpdateType;
  timestamp?: string;
};

export type ActivateAirportBookingJobData = {
  type: typeof ACTIVATE_AIRPORT_BOOKING;
  bookingId: string;
  activationAt?: string;
};

export type StatusUpdateJobData = HourlyStatusUpdateJobData | ActivateAirportBookingJobData;
