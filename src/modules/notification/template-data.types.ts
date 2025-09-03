import { NormalisedBookingDetails, NormalisedBookingLegDetails } from "../../types";

/**
 * Base template data that all notification templates can use
 */
export interface BaseTemplateData {
  customerName?: string;
  chauffeurName?: string;
  carName?: string;
  pickupLocation?: string;
  returnLocation?: string;
  bookingId?: string;
  subject?: string;
  recipientType?: string;
}

/**
 * Template data specific to booking status updates (includes email template fields)
 */
export interface BookingStatusTemplateData extends NormalisedBookingDetails {
  subject: string;
}

/**
 * Template data specific to booking reminders (includes email template fields)
 */
export interface BookingReminderTemplateData extends NormalisedBookingLegDetails {
  subject: string;
  recipientType: string;
}

/**
 * Union type for all possible template data structures
 */
export type TemplateData =
  | BookingStatusTemplateData
  | BookingReminderTemplateData
  | BaseTemplateData;

/**
 * Type guard to check if template data is for booking status updates
 */
export function isBookingStatusTemplateData(data: TemplateData): data is BookingStatusTemplateData {
  return "title" in data && "status" in data && "totalAmount" in data;
}

/**
 * Type guard to check if template data is for booking reminders
 */
export function isBookingReminderTemplateData(
  data: TemplateData,
): data is BookingReminderTemplateData {
  return "legStartTime" in data && "legEndTime" in data;
}
