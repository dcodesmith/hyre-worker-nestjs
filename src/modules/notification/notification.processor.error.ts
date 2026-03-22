import { NotificationChannel } from "./notification.interface";

export class NotificationDispatchError extends Error {
  constructor(
    public readonly notificationId: string,
    public readonly failedChannels: NotificationChannel[],
    public readonly attempt?: number,
    public readonly maxAttempts?: number,
  ) {
    super(
      `Notification channel delivery failed for notification ${notificationId}: ${failedChannels.join(", ")}`,
    );
    this.name = "NotificationDispatchError";
  }
}
