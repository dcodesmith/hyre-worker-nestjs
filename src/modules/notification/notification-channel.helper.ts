import { NotificationChannel } from "./notification.interface";

type NotificationChannelInput = {
  customerEmail?: string;
  customerPhone?: string;
  email?: string;
  phoneNumber?: string;
};

export function deriveNotificationChannels(input: NotificationChannelInput): NotificationChannel[] {
  const email = input.customerEmail ?? input.email;
  const phoneNumber = input.customerPhone ?? input.phoneNumber;
  const channels: NotificationChannel[] = [];

  if (email) {
    channels.push(NotificationChannel.EMAIL);
  }
  if (phoneNumber) {
    channels.push(NotificationChannel.WHATSAPP);
  }

  return channels;
}
