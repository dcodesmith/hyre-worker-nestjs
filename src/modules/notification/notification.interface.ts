import type { PushNotificationData } from "./notification-target";
import { RecipientType, TemplateData } from "./template-data.interface";

export enum NotificationChannel {
  EMAIL = "email",
  WHATSAPP = "whatsapp",
  PUSH = "push",
}

export enum NotificationAudience {
  CUSTOMER = "customer",
  FLEET_OWNER = "fleet-owner",
  CHAUFFEUR = "chauffeur",
  OPERATIONS = "operations",
}

export enum NotificationType {
  BOOKING_STATUS_CHANGE = "booking-status-change",
  BOOKING_REMINDER_START = "booking-reminder-start",
  BOOKING_REMINDER_END = "booking-reminder-end",
  BOOKING_CONFIRMED = "booking-confirmed",
  CHAUFFEUR_ASSIGNED = "chauffeur-assigned",
  BOOKING_CANCELLED = "booking-cancelled",
  BOOKING_EXTENSION_CONFIRMED = "booking-extension-confirmed",
  BOOKING_UPDATED = "booking-updated",
  FLEET_OWNER_NEW_BOOKING = "fleet-owner-new-booking",
  REVIEW_RECEIVED = "review-received",
  REFERRAL_REWARD_RELEASED = "referral-reward-released",
  PAYOUT_STATUS_CHANGED = "payout-status-changed",
  REFUND_STATUS_CHANGED = "refund-status-changed",
  FLIGHT_ARRIVED = "flight-arrived",
  FLIGHT_DEPARTED = "flight-departed",
  FLIGHT_DELAYED = "flight-delayed",
  FLIGHT_CANCELLED = "flight-cancelled",
  FLIGHT_DIVERTED = "flight-diverted",
  FLIGHT_GATE_CHANGED = "flight-gate-changed",
  FLIGHT_TERMINAL_CHANGED = "flight-terminal-changed",
  FLIGHT_DELAY_RECOVERED = "flight-delay-recovered",
  FLIGHT_REINSTATED = "flight-reinstated",
  FLIGHT_ASSIGNMENT_SNAPSHOT = "flight-assignment-snapshot",
  AIRPORT_SCHEDULE_CONFLICT = "airport-schedule-conflict",
}

export type FlightNotificationType =
  | NotificationType.FLIGHT_ARRIVED
  | NotificationType.FLIGHT_DEPARTED
  | NotificationType.FLIGHT_DELAYED
  | NotificationType.FLIGHT_CANCELLED
  | NotificationType.FLIGHT_DIVERTED
  | NotificationType.FLIGHT_GATE_CHANGED
  | NotificationType.FLIGHT_TERMINAL_CHANGED
  | NotificationType.FLIGHT_DELAY_RECOVERED
  | NotificationType.FLIGHT_REINSTATED
  | NotificationType.FLIGHT_ASSIGNMENT_SNAPSHOT
  | NotificationType.AIRPORT_SCHEDULE_CONFLICT;

export interface EmailNotificationData {
  to: string;
  subject: string;
  html: string;
}

export interface WhatsAppNotificationData {
  to: string;
  templateKey: string;
  variables: Record<string, string | number>;
}

export interface NotificationJobData {
  id: string;
  type: NotificationType;
  /**
   * Client audience allowed to receive push for this job.
   *
   * Optional only for backward compatibility with already-persisted outbox
   * rows and BullMQ jobs. New jobs must set it explicitly.
   */
  audience?: NotificationAudience;
  channels: NotificationChannel[];
  bookingId: string;
  pushPayload?: {
    title: string;
    body: string;
    data: PushNotificationData;
  };
  recipients: Partial<
    Record<
      RecipientType,
      {
        /**
         * Resolve active push tokens at delivery time. This keeps outbox
         * payloads free of token snapshots that can become stale before send.
         */
        userId?: string;
        email?: string;
        phoneNumber?: string;
        /**
         * Backward compatibility for jobs persisted before delivery-time token
         * resolution. New jobs should use `userId` instead.
         */
        pushTokens?: string[];
      }
    >
  >;
  templateData: TemplateData;
  priority?: number;
}

export interface NotificationResult {
  channel: NotificationChannel;
  success: boolean;
  /**
   * Whether channel failure should be retried by queue retry policy.
   * Undefined defaults to retryable for backward compatibility.
   */
  retryable?: boolean;
  messageId?: string;
  error?: string;
  perRecipientResults?: NotificationRecipientResult[];
}

interface NotificationRecipientResultBase {
  recipient: RecipientType;
  channel: NotificationChannel;
  success: boolean;
  messageId?: string;
  error?: string;
}

export type NotificationRecipientResult =
  | (NotificationRecipientResultBase & {
      channel: NotificationChannel.EMAIL;
      email: string;
    })
  | (NotificationRecipientResultBase & {
      channel: NotificationChannel.PUSH;
      pushToken: string;
      pushResponse?: {
        code: string;
        retryable: boolean;
        message?: string;
      };
    });

export interface ReviewReceivedNotificationParams {
  reviewId: string;
  bookingId: string;
  owner: {
    userId: string;
    name: string;
    email: string;
  };
  chauffeur: {
    userId: string;
    name: string;
    email: string;
  };
  review: {
    customerName: string;
    bookingReference: string;
    carName: string;
    overallRating: number;
    carRating: number;
    chauffeurRating: number;
    serviceRating: number;
    comment: string | null;
    reviewDate: Date;
  };
}

export interface ReferralRewardReleasedNotificationParams {
  rewardId: string;
  bookingId: string;
  referrerUserId: string;
  amount: number;
  releasedAt: Date;
}

export interface PayoutStatusChangedNotificationParams {
  payoutTransactionId: string;
  bookingId: string;
  bookingReference: string;
  status: "PAID_OUT" | "FAILED";
  amount: number;
  failureReason?: string;
  fleetOwner: {
    userId: string;
    name: string | null;
    email: string;
    phoneNumber: string | null;
  };
}

export interface RefundStatusChangedNotificationParams {
  refundId: string;
  paymentId: string;
  bookingId: string;
  bookingReference: string;
  status: "REFUNDED" | "PARTIALLY_REFUNDED" | "REFUND_FAILED" | "REFUND_REVIEW_REQUIRED";
  amount: number;
  failureReason?: string;
  customer: {
    userId?: string;
    name?: string | null;
    email?: string | null;
    phoneNumber?: string | null;
  };
}
