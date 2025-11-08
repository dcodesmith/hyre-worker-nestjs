import { NotificationChannel } from "./notification.interface";

export const DEFAULT_CHANNELS = [NotificationChannel.EMAIL, NotificationChannel.WHATSAPP];
export const STATUS_CHANGE_JOB_OPTIONS = { priority: 1 };
export const SEND_NOTIFICATION_JOB_NAME = "send-notification";
export { CLIENT_RECIPIENT_TYPE, CHAUFFEUR_RECIPIENT_TYPE } from "./template-data.interface";
