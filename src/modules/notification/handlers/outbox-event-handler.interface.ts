import type { NotificationInboxType, NotificationOutboxEventType } from "@prisma/client";
import type { NotificationJobData } from "../notification.interface";

/**
 * One unit of work produced by a handler. Inbox and jobData are independent:
 *
 * - `inbox` writes a row into the user-visible app inbox. Always emit this when
 *   a `userId` is available, regardless of whether `jobData` is present —
 *   inbox is in-app state, dispatch is delivery, and they should not gate each
 *   other (notification-outbox extensibility review, Issue 5A).
 * - `jobData` produces the durable outbox row that the dispatcher will pull and
 *   enqueue into BullMQ. Omit it (return only `inbox`) when there are no
 *   delivery channels for the recipient — the user still sees the event in
 *   the app, but no email/whatsapp/push attempt is made.
 *
 * `dedupeKey` must be deterministic per (booking-state-snapshot, recipient).
 * It is stored on `NotificationOutboxEvent` when `jobData` is present, and on
 * `NotificationInbox` when an inbox row is written — so inbox-only fan-out is
 * also deduplicated (same key as the outbox path when both are emitted).
 */
export type HandlerEvent = {
  jobData?: NotificationJobData;
  inbox?: HandlerInboxRow;
  dedupeKey: string;
  userId: string | null;
  subtype: string;
};

export type HandlerInboxRow = {
  userId: string;
  type: NotificationInboxType;
  title: string;
  body: string;
  payload: Record<string, unknown>;
};

/**
 * Per-event handler. Each booking lifecycle event (chauffeur-assigned, status
 * change, reminder, cancellation, ...) implements this contract in its own
 * file, registered via NestJS DI. The orchestrator
 * (`NotificationOutboxService.create`) is the single write entry point and
 * doesn't know per-event details — only handlers do.
 *
 * Adding a new event type requires creating one new handler + registering it
 * as a provider; nothing else in the outbox subsystem needs to change.
 */
export interface OutboxEventHandler<TInput> {
  readonly eventType: NotificationOutboxEventType;
  buildEvents(input: TInput): Promise<HandlerEvent[]>;
}
