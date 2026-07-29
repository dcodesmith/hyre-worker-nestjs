import { z } from "zod";
import { NotificationType } from "./notification.interface";

export const BOOKING_NOTIFICATION_TARGET_KIND = "booking" as const;
export const REFERRALS_NOTIFICATION_TARGET_KIND = "referrals" as const;

const notificationTypeValues = Object.values(NotificationType) as [
  NotificationType,
  ...NotificationType[],
];

export const notificationTypeSchema = z.enum(notificationTypeValues);

export const bookingNotificationTargetSchema = z
  .object({
    kind: z.literal(BOOKING_NOTIFICATION_TARGET_KIND),
    bookingId: z.string().min(1),
  })
  .strict();

export const referralsNotificationTargetSchema = z
  .object({
    kind: z.literal(REFERRALS_NOTIFICATION_TARGET_KIND),
  })
  .strict();

export const pushNotificationDataSchema = z.object({
  type: notificationTypeSchema,
  target: z.discriminatedUnion("kind", [
    bookingNotificationTargetSchema,
    referralsNotificationTargetSchema,
  ]),
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

export function createReferralsNotificationData(type: NotificationType): PushNotificationData {
  return {
    type,
    target: {
      kind: REFERRALS_NOTIFICATION_TARGET_KIND,
    },
  };
}
