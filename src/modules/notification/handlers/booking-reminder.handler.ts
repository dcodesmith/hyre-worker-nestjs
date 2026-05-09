import { Injectable } from "@nestjs/common";
import { NotificationInboxType, NotificationOutboxEventType } from "@prisma/client";
import { normaliseBookingLegDetails } from "../../../shared/helper";
import { CHAUFFEUR_RECIPIENT_TYPE, CLIENT_RECIPIENT_TYPE } from "../notification.const";
import { NotificationType } from "../notification.interface";
import { NotificationService, ReminderRecipientContext } from "../notification.service";
import type { HandlerEvent, OutboxEventHandler } from "./outbox-event-handler.interface";

const SUBTYPE_BY_TYPE: Record<
  NotificationType.BOOKING_REMINDER_START | NotificationType.BOOKING_REMINDER_END,
  "BOOKING_REMINDER_START" | "BOOKING_REMINDER_END"
> = {
  [NotificationType.BOOKING_REMINDER_START]: "BOOKING_REMINDER_START",
  [NotificationType.BOOKING_REMINDER_END]: "BOOKING_REMINDER_END",
};

export type BookingReminderInput = {
  bookingLeg: Parameters<typeof normaliseBookingLegDetails>[0];
  type: NotificationType.BOOKING_REMINDER_START | NotificationType.BOOKING_REMINDER_END;
  /**
   * Optional pre-resolved push tokens for fan-out batching. Reminder cron can
   * fetch tokens for many recipients in one round-trip and pass them in to
   * avoid N+1 lookups (perf review, Issue 13A).
   */
  context?: Pick<ReminderRecipientContext, "customerPushTokens" | "chauffeurPushTokens">;
};

@Injectable()
export class BookingReminderHandler implements OutboxEventHandler<BookingReminderInput> {
  readonly eventType = NotificationOutboxEventType.BOOKING_REMINDER;

  constructor(private readonly notificationService: NotificationService) {}

  async buildEvents({ bookingLeg, type, context }: BookingReminderInput): Promise<HandlerEvent[]> {
    const subtype = SUBTYPE_BY_TYPE[type];
    const inboxTitle =
      type === NotificationType.BOOKING_REMINDER_START
        ? "Booking starts in 1 hour"
        : "Booking ends in 1 hour";
    const inboxBody =
      type === NotificationType.BOOKING_REMINDER_START
        ? "Your booking is starting soon."
        : "Your booking is ending soon.";

    const reminderJobs = await this.notificationService.buildBookingReminderJobData(
      normaliseBookingLegDetails(bookingLeg),
      type,
      {
        customerUserId: bookingLeg.booking.userId ?? undefined,
        chauffeurUserId: bookingLeg.booking.chauffeurId ?? undefined,
        customerPushTokens: context?.customerPushTokens,
        chauffeurPushTokens: context?.chauffeurPushTokens,
      },
    );

    // Index jobs by recipient type so we can correlate each user with their
    // jobData (or lack thereof, when the recipient has no delivery channel).
    const jobByRecipient = new Map<string, (typeof reminderJobs)[number]>();
    for (const job of reminderJobs) {
      const recipientType = Object.keys(job.recipients)[0];
      if (recipientType) {
        jobByRecipient.set(recipientType, job);
      }
    }

    const recipients: { recipientType: string; userId: string | null }[] = [
      { recipientType: CLIENT_RECIPIENT_TYPE, userId: bookingLeg.booking.userId ?? null },
      { recipientType: CHAUFFEUR_RECIPIENT_TYPE, userId: bookingLeg.booking.chauffeurId ?? null },
    ];

    const events: HandlerEvent[] = [];
    for (const { recipientType, userId } of recipients) {
      const jobData = jobByRecipient.get(recipientType);
      const event: HandlerEvent = {
        jobData,
        dedupeKey: `booking-reminder:${bookingLeg.id}:${recipientType}:${type}:${bookingLeg.updatedAt.toISOString()}`,
        userId,
        subtype,
      };

      if (userId) {
        event.inbox = {
          userId,
          type: NotificationInboxType.BOOKING_REMINDER,
          title: inboxTitle,
          body: inboxBody,
          payload: {
            bookingId: bookingLeg.booking.id,
            bookingLegId: bookingLeg.id,
            type,
            recipientType,
          },
        };
      }

      if (event.inbox || event.jobData) {
        events.push(event);
      }
    }

    return events;
  }
}
