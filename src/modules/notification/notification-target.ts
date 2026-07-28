import { z } from "zod";
import { NotificationType } from "./notification.interface";

export const BOOKING_NOTIFICATION_TARGET_KIND = "booking" as const;

const notificationTypeValues = Object.values(NotificationType) as [
  NotificationType,
  ...NotificationType[],
];

export const notificationTypeSchema = z.enum(notificationTypeValues);

export const bookingNotificationTargetSchema = z.object({
  kind: z.literal(BOOKING_NOTIFICATION_TARGET_KIND),
  bookingId: z.string().min(1),
});

export const pushNotificationDataSchema = z.object({
  type: notificationTypeSchema,
  target: bookingNotificationTargetSchema,
});

export type PushNotificationData = z.infer<typeof pushNotificationDataSchema>;

export function createBookingNotificationData(
  type: NotificationType,
  bookingId: string,
): PushNotificationData {
  return {
    type,
    target: {
      kind: BOOKING_NOTIFICATION_TARGET_KIND,
      bookingId,
    },
  };
}
