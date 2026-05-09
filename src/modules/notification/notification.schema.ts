import { NotificationOutboxEventType } from "@prisma/client";
import { z } from "zod";
import { NotificationChannel, NotificationType } from "./notification.interface";

const notificationTypeValues = Object.values(NotificationType) as [
  NotificationType,
  ...NotificationType[],
];
const notificationChannelValues = Object.values(NotificationChannel) as [
  NotificationChannel,
  ...NotificationChannel[],
];
const outboxEventTypeValues = Object.values(NotificationOutboxEventType) as [
  NotificationOutboxEventType,
  ...NotificationOutboxEventType[],
];

/**
 * Structural Zod validator for `NotificationJobData` envelopes durably stored
 * in the outbox. This guards the JSON ↔ runtime boundary; semantic typing of
 * `templateData` (the discriminated union of template kinds) is enforced by
 * the `NotificationJobData` TS interface in `notification.interface.ts`.
 *
 * Drift between this envelope and the TS interface is locked by
 * `notification-job-data.contract.spec.ts`.
 */
export const notificationJobDataSchema = z.object({
  id: z.string().min(1),
  type: z.enum(notificationTypeValues),
  channels: z.array(z.enum(notificationChannelValues)),
  bookingId: z.string().min(1),
  pushPayload: z
    .object({
      title: z.string(),
      body: z.string(),
      data: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  recipients: z.record(
    z.string(),
    z.object({
      email: z.string().optional(),
      phoneNumber: z.string().optional(),
      pushTokens: z.array(z.string()).optional(),
    }),
  ),
  templateData: z.record(z.string(), z.unknown()),
  priority: z.number().optional(),
});

/**
 * Outer payload validator for the `NotificationOutboxEvent.payload` JSON
 * column. `subtype` is opaque to the dispatcher — handlers own their subtypes
 * for observability/dedupe; the dispatcher only cares that the envelope is
 * structurally valid and contains a parseable `notificationJobData`.
 *
 * Adding a new event type requires no edits here.
 */
export const outboxPayloadSchema = z.object({
  eventType: z.enum(outboxEventTypeValues),
  subtype: z.string().min(1),
  notificationJobData: notificationJobDataSchema,
});
