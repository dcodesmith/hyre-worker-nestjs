import { Test, type TestingModule } from "@nestjs/testing";
import { NotificationInboxType, NotificationOutboxEventType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBooking, createCar, createOwner, createUser } from "../../../shared/helper.fixtures";
import { NotificationService } from "../notification.service";
import { BookingConfirmedHandler } from "./booking-confirmed.handler";

const customerJobData = {
  id: "booking-confirmed-booking-1",
  type: "booking-confirmed" as const,
  channels: ["push" as const],
  bookingId: "booking-1",
  recipients: { client: { userId: "user-1" } },
  pushPayload: {
    title: "Booking confirmed",
    body: "Your booking has been confirmed.",
    data: {
      type: "booking-confirmed" as const,
      target: { kind: "booking" as const, bookingId: "booking-1" },
    },
  },
  templateData: {},
};

const ownerJobData = {
  id: "fleet-owner-new-booking-booking-1",
  type: "fleet-owner-new-booking" as const,
  channels: ["email" as const],
  bookingId: "booking-1",
  recipients: { fleetOwner: { email: "owner@example.com" } },
  templateData: {},
};

describe("BookingConfirmedHandler", () => {
  let handler: BookingConfirmedHandler;
  let notificationService: { buildBookingConfirmedJobData: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    notificationService = { buildBookingConfirmedJobData: vi.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingConfirmedHandler,
        { provide: NotificationService, useValue: notificationService },
      ],
    }).compile();

    handler = module.get(BookingConfirmedHandler);
  });

  it("emits customer inbox/outbox and owner outbox with deterministic keys", async () => {
    notificationService.buildBookingConfirmedJobData.mockResolvedValueOnce({
      customer: customerJobData,
      owner: ownerJobData,
    });
    const booking = createBooking({
      id: "booking-1",
      userId: "user-1",
      user: createUser({ id: "user-1" }),
      car: createCar({ owner: createOwner() }),
      updatedAt: new Date("2026-07-27T12:00:00.000Z"),
    });

    const events = await handler.buildEvents({ booking });

    expect(handler.eventType).toBe(NotificationOutboxEventType.BOOKING_LIFECYCLE);
    expect(events).toEqual([
      {
        jobData: customerJobData,
        dedupeKey: "booking-confirmed:booking-1:client:2026-07-27T12:00:00.000Z",
        userId: "user-1",
        subtype: "BOOKING_CONFIRMED_CUSTOMER",
        inbox: {
          userId: "user-1",
          type: NotificationInboxType.BOOKING_LIFECYCLE,
          title: "Booking confirmed",
          body: "Your booking has been confirmed.",
          payload: { bookingId: "booking-1", status: "CONFIRMED" },
        },
      },
      {
        jobData: ownerJobData,
        dedupeKey: "booking-confirmed:booking-1:fleet-owner:2026-07-27T12:00:00.000Z",
        userId: null,
        subtype: "BOOKING_CONFIRMED_OWNER",
      },
    ]);
  });

  it("keeps the customer inbox when no delivery channel is available", async () => {
    notificationService.buildBookingConfirmedJobData.mockResolvedValueOnce({
      customer: null,
      owner: null,
    });
    const booking = createBooking({
      userId: "user-1",
      user: createUser({ id: "user-1" }),
    });

    const events = await handler.buildEvents({ booking });

    expect(events).toHaveLength(1);
    expect(events[0].inbox).toBeDefined();
    expect(events[0].jobData).toBeUndefined();
  });

  it("uses the referral savings copy in the existing confirmation inbox event", async () => {
    notificationService.buildBookingConfirmedJobData.mockResolvedValueOnce({
      customer: {
        ...customerJobData,
        pushPayload: {
          ...customerJobData.pushPayload,
          body: "Your booking is confirmed. You saved ₦5,000.00 with your referral discount.",
        },
      },
      owner: null,
    });
    const booking = createBooking({
      id: "booking-1",
      userId: "user-1",
      user: createUser({ id: "user-1" }),
    });

    const events = await handler.buildEvents({ booking });

    expect(events[0].inbox?.body).toBe(
      "Your booking is confirmed. You saved ₦5,000.00 with your referral discount.",
    );
  });

  it("omits customer events for guests without delivery channels", async () => {
    notificationService.buildBookingConfirmedJobData.mockResolvedValueOnce({
      customer: null,
      owner: ownerJobData,
    });
    const booking = createBooking({ userId: null, user: null });

    const events = await handler.buildEvents({ booking });

    expect(events).toHaveLength(1);
    expect(events[0].subtype).toBe("BOOKING_CONFIRMED_OWNER");
  });
});
