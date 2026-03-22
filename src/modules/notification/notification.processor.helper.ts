import { NotificationChannel } from "./notification.interface";

export function getSucceededChannels(progress: unknown): NotificationChannel[] {
  if (
    typeof progress === "object" &&
    progress !== null &&
    "succeededChannels" in progress &&
    Array.isArray((progress as { succeededChannels?: unknown }).succeededChannels)
  ) {
    return (progress as { succeededChannels: NotificationChannel[] }).succeededChannels;
  }
  return [];
}
