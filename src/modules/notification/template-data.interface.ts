import type { NormalisedBookingDetails, NormalisedBookingLegDetails } from "../../types";

export const CLIENT_RECIPIENT_TYPE = "client" as const;
export const CHAUFFEUR_RECIPIENT_TYPE = "chauffeur" as const;
export const FLEET_OWNER_RECIPIENT_TYPE = "fleetOwner" as const;
export type RecipientType =
  | typeof CLIENT_RECIPIENT_TYPE
  | typeof CHAUFFEUR_RECIPIENT_TYPE
  | typeof FLEET_OWNER_RECIPIENT_TYPE;

export const BOOKING_STATUS_TEMPLATE_KIND = "bookingStatusChange" as const;
export const BOOKING_REMINDER_TEMPLATE_KIND = "bookingReminder" as const;
export const BOOKING_CONFIRMED_TEMPLATE_KIND = "bookingConfirmed" as const;
export const FLEET_OWNER_NEW_BOOKING_TEMPLATE_KIND = "fleetOwnerNewBooking" as const;
export const REVIEW_RECEIVED_TEMPLATE_KIND = "reviewReceived" as const;
export type TemplateKind =
  | typeof BOOKING_STATUS_TEMPLATE_KIND
  | typeof BOOKING_REMINDER_TEMPLATE_KIND
  | typeof BOOKING_CONFIRMED_TEMPLATE_KIND
  | typeof FLEET_OWNER_NEW_BOOKING_TEMPLATE_KIND
  | typeof REVIEW_RECEIVED_TEMPLATE_KIND;

/**
 * Template data specific to booking status updates (includes email template fields)
 */
export interface BookingStatusTemplateData extends NormalisedBookingDetails {
  templateKind: typeof BOOKING_STATUS_TEMPLATE_KIND;
  subject: string;
  oldStatus: string;
  newStatus: string;
  showReviewRequest?: boolean;
}

/**
 * Template data specific to booking reminders (includes email template fields)
 */
export interface BookingReminderTemplateData extends NormalisedBookingLegDetails {
  templateKind: typeof BOOKING_REMINDER_TEMPLATE_KIND;
  subject: string;
  recipientType: RecipientType;
}

/**
 * Template data specific to booking confirmation after payment
 */
export interface BookingConfirmedTemplateData extends NormalisedBookingDetails {
  templateKind: typeof BOOKING_CONFIRMED_TEMPLATE_KIND;
  subject: string;
}

export interface FleetOwnerNewBookingTemplateData extends NormalisedBookingDetails {
  templateKind: typeof FLEET_OWNER_NEW_BOOKING_TEMPLATE_KIND;
  subject: string;
}

/**
 * Template data for review received notifications (owner/chauffeur).
 */
export interface ReviewReceivedTemplateData {
  templateKind: typeof REVIEW_RECEIVED_TEMPLATE_KIND;
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
  | FleetOwnerNewBookingTemplateData
  | ReviewReceivedTemplateData;
