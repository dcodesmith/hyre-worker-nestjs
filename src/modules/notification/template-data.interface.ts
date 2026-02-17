import { NormalisedBookingDetails, NormalisedBookingLegDetails } from "../../types";

export const CLIENT_RECIPIENT_TYPE = "client" as const;
export const CHAUFFEUR_RECIPIENT_TYPE = "chauffeur" as const;
export const FLEET_OWNER_RECIPIENT_TYPE = "fleetOwner" as const;
export type RecipientType =
  | typeof CLIENT_RECIPIENT_TYPE
  | typeof CHAUFFEUR_RECIPIENT_TYPE
  | typeof FLEET_OWNER_RECIPIENT_TYPE;

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
  recipientType?: RecipientType;
}

/**
 * Template data specific to booking status updates (includes email template fields)
 */
export interface BookingStatusTemplateData extends NormalisedBookingDetails {
  subject: string;
  oldStatus: string;
  newStatus: string;
  showReviewRequest?: boolean;
}

/**
 * Template data specific to booking reminders (includes email template fields)
 */
export interface BookingReminderTemplateData extends NormalisedBookingLegDetails {
  subject: string;
  recipientType: RecipientType;
}

/**
 * Template data specific to booking confirmation after payment
 */
export interface BookingConfirmedTemplateData extends NormalisedBookingDetails {
  subject: string;
}

/**
 * Template data for review received notifications (owner/chauffeur).
 */
export interface ReviewReceivedTemplateData {
  ownerName?: string;
  chauffeurName?: string;
  customerName: string;
  bookingReference: string;
  carName: string;
  overallRating: number;
  carRating: number;
  chauffeurRating: number;
  serviceRating: number;
  comment: string | null;
  reviewDate: Date | string;
  subject: string;
}

/**
 * Union type for all possible template data structures
 */
export type TemplateData =
  | BookingStatusTemplateData
  | BookingReminderTemplateData
  | BookingConfirmedTemplateData
  | ReviewReceivedTemplateData
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
  return "legStartTime" in data && "legEndTime" in data && "bookingId" in data;
}

/**
 * Type guard to check if template data is for booking confirmation
 */
export function isBookingConfirmedTemplateData(
  data: TemplateData,
): data is BookingConfirmedTemplateData {
  // BookingConfirmedTemplateData has NormalisedBookingDetails fields but no oldStatus/newStatus
  return (
    "bookingReference" in data &&
    "totalAmount" in data &&
    !("oldStatus" in data) &&
    !("legStartTime" in data)
  );
}

/**
 * Type guard to check if template data is for review received notifications.
 */
export function isReviewReceivedTemplateData(
  data: TemplateData,
): data is ReviewReceivedTemplateData {
  return (
    "bookingReference" in data &&
    "overallRating" in data &&
    "chauffeurRating" in data &&
    "reviewDate" in data &&
    (data.reviewDate instanceof Date || typeof data.reviewDate === "string")
  );
}
