import { NotificationChannel } from "./notification.interface";

export const DEFAULT_CHANNELS = [NotificationChannel.EMAIL, NotificationChannel.WHATSAPP];
export const HIGH_PRIORITY_JOB_OPTIONS = { priority: 1 };
export const SEND_NOTIFICATION_JOB_NAME = "send-notification";
export {
  CHAUFFEUR_RECIPIENT_TYPE,
  CLIENT_RECIPIENT_TYPE,
  FLEET_OWNER_RECIPIENT_TYPE,
} from "./template-data.interface";
