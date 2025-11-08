import { CHAUFFEUR_RECIPIENT_TYPE, CLIENT_RECIPIENT_TYPE } from "./notification.const";
import { TemplateData } from "./template-data.interface";

export enum NotificationChannel {
  EMAIL = "email",
  WHATSAPP = "whatsapp",
}

export enum NotificationType {
  BOOKING_STATUS_CHANGE = "booking-status-change",
  BOOKING_REMINDER_START = "booking-reminder-start",
  BOOKING_REMINDER_END = "booking-reminder-end",
}

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
  channels: NotificationChannel[];
  bookingId: string;
  recipients: Partial<
    Record<
      RecipientType,
      {
        email?: string;
        phoneNumber?: string;
      }
    >
  >;
  templateData: TemplateData;
  priority?: number;
}

export interface NotificationResult {
  channel: NotificationChannel;
  success: boolean;
  messageId?: string;
  error?: string;
}

export type RecipientType = typeof CLIENT_RECIPIENT_TYPE | typeof CHAUFFEUR_RECIPIENT_TYPE;
