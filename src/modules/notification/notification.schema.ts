import { NotificationOutboxEventType } from "@prisma/client";
import { z } from "zod";
import { NotificationAudience, NotificationChannel } from "./notification.interface";
import { notificationTypeSchema, pushNotificationDataSchema } from "./notification-target";
import { TEMPLATE_KINDS } from "./template-data.interface";

const notificationChannelValues = Object.values(NotificationChannel) as [
  NotificationChannel,
  ...NotificationChannel[],
];

const notificationAudienceValues = Object.values(NotificationAudience) as [
  NotificationAudience,
  ...NotificationAudience[],
];

const outboxEventTypeValues = Object.values(NotificationOutboxEventType) as [
  NotificationOutboxEventType,
  ...NotificationOutboxEventType[],
];

/**
 * Boundary check for persisted `templateData`. A known `templateKind` is
 * required; rows without it fail parse and are dead-lettered. Per-kind fields
 * stay loose so incomplete rows with a valid discriminator still parse.
 */
export const templateDataSchema = z.looseObject({
  templateKind: z.enum(TEMPLATE_KINDS),
});

/**
 * Structural Zod validator for `NotificationJobData` envelopes durably stored
 * in the outbox. This guards the JSON ↔ runtime boundary.
 *
 * Drift between this envelope and the TS interface is locked by
 * `notification-job-data.contract.spec.ts`.
 */
export const notificationJobDataSchema = z.object({
  id: z.string().min(1),
  type: notificationTypeSchema,
  // Optional while pre-migration jobs/outbox rows remain readable.
  audience: z.enum(notificationAudienceValues).optional(),
  channels: z.array(z.enum(notificationChannelValues)).min(1),
  bookingId: z.string().min(1),
  airportCompletionLink: z.literal(true).optional(),
  pushPayload: z
    .object({
      title: z.string(),
      body: z.string(),
      data: pushNotificationDataSchema,
    })
    .optional(),
  recipients: z.record(
    z.string(),
    z.object({
      userId: z.string().min(1).optional(),
      email: z.string().optional(),
      phoneNumber: z.string().optional(),
      // Legacy token snapshots remain parseable until retained jobs expire.
      pushTokens: z.array(z.string()).optional(),
    }),
  ),
  templateData: templateDataSchema,
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
