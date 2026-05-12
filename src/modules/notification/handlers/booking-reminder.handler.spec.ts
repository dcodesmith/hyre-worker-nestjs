import { Test, type TestingModule } from "@nestjs/testing";
import { NotificationInboxType, NotificationOutboxEventType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBooking,
  createBookingLeg,
  createCar,
  createChauffeur,
  createOwner,
  createUser,
} from "../../../shared/helper.fixtures";
import { CHAUFFEUR_RECIPIENT_TYPE, CLIENT_RECIPIENT_TYPE } from "../notification.const";
import { NotificationType } from "../notification.interface";
import { NotificationService } from "../notification.service";
import { BookingReminderHandler } from "./booking-reminder.handler";

const customerJob = {
  id: "reminder-customer-leg-1",
  type: NotificationType.BOOKING_REMINDER_START,
  channels: ["email" as const, "push" as const],
  bookingId: "booking-1",
  recipients: { [CLIENT_RECIPIENT_TYPE]: { email: "j@x.com", pushTokens: ["t1"] } },
  templateData: {},
};

const chauffeurJob = {
  id: "reminder-chauffeur-leg-1",
  type: NotificationType.BOOKING_REMINDER_START,
  channels: ["push" as const],
  bookingId: "booking-1",
  recipients: { [CHAUFFEUR_RECIPIENT_TYPE]: { pushTokens: ["t2"] } },
  templateData: {},
};

const buildLeg = (
  overrides: {
    id?: string;
    bookingId?: string;
    userId?: string | null;
    chauffeurId?: string | null;
    updatedAt?: Date;
  } = {},
) => {
  const customer = createUser({ id: overrides.userId ?? "user-1" });
  const chauffeur = createChauffeur({ id: overrides.chauffeurId ?? "chauffeur-1" });
  const booking = createBooking({
    id: overrides.bookingId ?? "booking-1",
    user: overrides.userId === null ? null : customer,
    userId: overrides.userId === null ? null : customer.id,
    chauffeur: overrides.chauffeurId === null ? null : chauffeur,
    chauffeurId: overrides.chauffeurId === null ? null : chauffeur.id,
    car: createCar({ owner: createOwner() }),
  });
  return {
    ...createBookingLeg({
      id: overrides.id ?? "leg-1",
      bookingId: booking.id,
      updatedAt: overrides.updatedAt ?? new Date("2026-05-09T14:00:00Z"),
    }),
    booking,
  };
};

describe("BookingReminderHandler", () => {
  let handler: BookingReminderHandler;
  let notificationService: { buildBookingReminderJobData: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    notificationService = { buildBookingReminderJobData: vi.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingReminderHandler,
        { provide: NotificationService, useValue: notificationService },
      ],
    }).compile();

    handler = module.get(BookingReminderHandler);
  });

  it("uses BOOKING_REMINDER eventType", () => {
    expect(handler.eventType).toBe(NotificationOutboxEventType.BOOKING_REMINDER);
  });

  it("fans out to a customer event and a chauffeur event with deterministic dedupe keys", async () => {
    notificationService.buildBookingReminderJobData.mockResolvedValueOnce([
      customerJob,
      chauffeurJob,
    ]);
    const leg = buildLeg();

    const events = await handler.buildEvents({
      bookingLeg: leg,
      type: NotificationType.BOOKING_REMINDER_START,
    });

    expect(events).toHaveLength(2);
    const byRecipient = Object.fromEntries(
      events.map((event) => [Object.keys(event.jobData?.recipients ?? {})[0], event] as const),
    );

    expect(byRecipient[CLIENT_RECIPIENT_TYPE]?.subtype).toBe("BOOKING_REMINDER_START");
    expect(byRecipient[CLIENT_RECIPIENT_TYPE]?.dedupeKey).toBe(
      "booking-reminder:leg-1:client:booking-reminder-start:2026-05-09T14:00:00.000Z",
    );
    expect(byRecipient[CHAUFFEUR_RECIPIENT_TYPE]?.dedupeKey).toBe(
      "booking-reminder:leg-1:chauffeur:booking-reminder-start:2026-05-09T14:00:00.000Z",
    );
  });

  it("threads pre-resolved push tokens from context into the job-data builder (Issue 13A)", async () => {
    notificationService.buildBookingReminderJobData.mockResolvedValueOnce([]);
    const leg = buildLeg();

    await handler.buildEvents({
      bookingLeg: leg,
      type: NotificationType.BOOKING_REMINDER_END,
      context: {
        customerPushTokens: ["t-cust-1", "t-cust-2"],
        chauffeurPushTokens: ["t-chauf-1"],
      },
    });

    expect(notificationService.buildBookingReminderJobData).toHaveBeenCalledWith(
      expect.anything(),
      NotificationType.BOOKING_REMINDER_END,
      {
        customerUserId: "user-1",
        chauffeurUserId: "chauffeur-1",
        customerPushTokens: ["t-cust-1", "t-cust-2"],
        chauffeurPushTokens: ["t-chauf-1"],
      },
    );
  });

  // Issue 5A: inbox row for the customer must persist regardless of whether
  // the underlying job-data path is empty (no channels available).
  it("emits the customer inbox row even when no jobData is produced for that recipient", async () => {
    // Builder returns only the chauffeur job — no customer delivery channels.
    notificationService.buildBookingReminderJobData.mockResolvedValueOnce([chauffeurJob]);
    const leg = buildLeg();

    const events = await handler.buildEvents({
      bookingLeg: leg,
      type: NotificationType.BOOKING_REMINDER_START,
    });

    expect(events).toHaveLength(2);
    const customerEvent = events.find((event) => event.userId === "user-1");
    expect(customerEvent?.jobData).toBeUndefined();
    expect(customerEvent?.inbox).toEqual(
      expect.objectContaining({
        userId: "user-1",
        type: NotificationInboxType.BOOKING_REMINDER,
      }),
    );
  });

  it("uses end-reminder copy when type is BOOKING_REMINDER_END", async () => {
    notificationService.buildBookingReminderJobData.mockResolvedValueOnce([customerJob]);
    const leg = buildLeg();

    const events = await handler.buildEvents({
      bookingLeg: leg,
      type: NotificationType.BOOKING_REMINDER_END,
    });

    const customerEvent = events.find((event) => event.userId === "user-1");
    expect(customerEvent?.subtype).toBe("BOOKING_REMINDER_END");
    expect(customerEvent?.inbox?.title).toBe("Booking ends in 1 hour");
    expect(customerEvent?.inbox?.body).toBe("Your booking is ending soon.");
  });

  it("skips a recipient slot entirely when both userId and jobData are missing", async () => {
    notificationService.buildBookingReminderJobData.mockResolvedValueOnce([customerJob]);
    // Chauffeur not assigned and no chauffeur job — should not produce a chauffeur event.
    const leg = buildLeg({ chauffeurId: null });

    const events = await handler.buildEvents({
      bookingLeg: leg,
      type: NotificationType.BOOKING_REMINDER_START,
    });

    expect(events).toHaveLength(1);
    expect(events[0].userId).toBe("user-1");
  });
});
