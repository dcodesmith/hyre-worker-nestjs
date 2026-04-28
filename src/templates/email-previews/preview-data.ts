/**
 * Sample props for React Email preview (`pnpm email:dev`) only.
 * Matches payloads sent via notification.processor + auth-email.service.
 */
import type {
  BookingCancelledTemplateData,
  BookingExtensionConfirmedTemplateData,
  ReviewReceivedTemplateData,
} from "../../modules/notification/template-data.interface";
import {
  BOOKING_CANCELLED_TEMPLATE_KIND,
  BOOKING_EXTENSION_CONFIRMED_TEMPLATE_KIND,
  REVIEW_RECEIVED_TEMPLATE_KIND,
} from "../../modules/notification/template-data.interface";
import type { NormalisedBookingDetails, NormalisedBookingLegDetails } from "../../types";

export const sampleBooking: NormalisedBookingDetails = {
  bookingReference: "TRP-8F2K9Q",
  id: "clsamplebooking001",
  customerName: "Alex Johnson",
  ownerName: "Fleet Lagos Ltd",
  chauffeurName: "Sam Driver",
  chauffeurPhoneNumber: "+234 800 000 0000",
  carName: "Mercedes-Benz S-Class (2024)",
  pickupLocation: "Murtala Muhammed International Airport, Lagos",
  returnLocation: "Eko Hotels & Suites, Victoria Island",
  startDate: "Tue, Apr 21, 2026 · 2:00 PM",
  endDate: "Thu, Apr 23, 2026 · 10:00 AM",
  totalAmount: "₦450,000.00",
  title: "confirmed",
  status: "confirmed",
  cancellationReason: "",
};

export const sampleBookingStatusWithReview: NormalisedBookingDetails & {
  showReviewRequest?: boolean;
} = {
  ...sampleBooking,
  title: "started",
  status: "active",
  showReviewRequest: true,
};

export const sampleBookingLeg: NormalisedBookingLegDetails = {
  bookingLegId: "clsampleleg001",
  bookingId: "clsamplebooking001",
  customerName: "Alex Johnson",
  chauffeurName: "Sam Driver",
  legDate: "Tue, Apr 21, 2026",
  legStartTime: "Tue, Apr 21, 2026 · 2:00 PM",
  legEndTime: "Thu, Apr 23, 2026 · 10:00 AM",
  carName: "Mercedes-Benz S-Class (2024)",
  pickupLocation: "Murtala Muhammed International Airport, Lagos",
  returnLocation: "Eko Hotels & Suites, Victoria Island",
};

export const sampleUserCancellation: BookingCancelledTemplateData = {
  ...sampleBooking,
  templateKind: BOOKING_CANCELLED_TEMPLATE_KIND,
  subject: "Booking cancelled",
  title: "cancelled",
  status: "cancelled",
  cancellationReason: "Change of travel plans",
};

export const sampleFleetOwnerCancellation: BookingCancelledTemplateData = {
  ...sampleUserCancellation,
  subject: "Fleet: booking cancelled",
};

export const sampleExtension: BookingExtensionConfirmedTemplateData = {
  ...sampleBooking,
  templateKind: BOOKING_EXTENSION_CONFIRMED_TEMPLATE_KIND,
  subject: "Extension confirmed",
  legDate: "Tue, Apr 21, 2026",
  extensionHours: 2,
  from: "4:00 PM",
  to: "6:00 PM",
};

export const sampleReviewReceived: ReviewReceivedTemplateData = {
  templateKind: REVIEW_RECEIVED_TEMPLATE_KIND,
  subject: "New review",
  customerName: "Alex Johnson",
  bookingReference: "TRP-8F2K9Q",
  carName: "Mercedes-Benz S-Class (2024)",
  overallRating: 4.5,
  carRating: 5,
  chauffeurRating: 4,
  serviceRating: 4.5,
  comment: "Smooth pickup and excellent vehicle condition.",
  reviewDate: "Wed, Apr 22, 2026",
};
