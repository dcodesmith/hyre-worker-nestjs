import { Test, type TestingModule } from "@nestjs/testing";
import { NotificationInboxType, NotificationOutboxEventType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBooking, createCar, createOwner, createUser } from "../../../shared/helper.fixtures";
import { NotificationService } from "../notification.service";
import { BookingCancellationHandler } from "./booking-cancellation.handler";

const customerJobData = {
  id: "booking-cancelled-customer-booking-1",
  type: "booking-cancelled" as const,
  channels: ["email" as const],
  bookingId: "booking-1",
  recipients: { client: { email: "j@x.com" } },
  templateData: {},
};

const ownerJobData = {
  id: "booking-cancelled-owner-booking-1",
  type: "booking-cancelled" as const,
  channels: ["email" as const],
  bookingId: "booking-1",
  recipients: { fleetOwner: { email: "owner@x.com" } },
  templateData: {},
};

describe("BookingCancellationHandler", () => {
  let handler: BookingCancellationHandler;
  let notificationService: { buildBookingCancellationJobData: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    notificationService = { buildBookingCancellationJobData: vi.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingCancellationHandler,
        { provide: NotificationService, useValue: notificationService },
      ],
    }).compile();

    handler = module.get(BookingCancellationHandler);
  });

  it("uses BOOKING_LIFECYCLE eventType (cancellation is a lifecycle transition)", () => {
    expect(handler.eventType).toBe(NotificationOutboxEventType.BOOKING_LIFECYCLE);
  });

  it("emits a customer event (inbox + outbox) and an owner event (outbox only)", async () => {
    notificationService.buildBookingCancellationJobData.mockResolvedValueOnce({
      customer: customerJobData,
      owner: ownerJobData,
    });
    const cancelledAt = new Date("2026-05-09T12:00:00Z");
    const booking = createBooking({
      id: "booking-1",
      userId: "user-1",
      user: createUser({ id: "user-1" }),
      car: createCar({ owner: createOwner() }),
      cancelledAt,
    });

    const events = await handler.buildEvents({ booking });

    expect(events).toHaveLength(2);
    const [customerEvent, ownerEvent] = events;

    expect(customerEvent.subtype).toBe("BOOKING_CANCELLED_CUSTOMER");
    expect(customerEvent.userId).toBe("user-1");
    expect(customerEvent.dedupeKey).toBe(
      "booking-cancelled:booking-1:client:2026-05-09T12:00:00.000Z",
    );
    expect(customerEvent.jobData).toBe(customerJobData);
    expect(customerEvent.inbox).toEqual({
      userId: "user-1",
      type: NotificationInboxType.BOOKING_LIFECYCLE,
      title: "Booking cancelled",
      body: "Your booking has been cancelled. A refund is being processed.",
      payload: { bookingId: "booking-1", status: "CANCELLED" },
    });

    expect(ownerEvent.subtype).toBe("BOOKING_CANCELLED_OWNER");
    expect(ownerEvent.userId).toBeNull();
    expect(ownerEvent.inbox).toBeUndefined();
    expect(ownerEvent.jobData).toBe(ownerJobData);
    expect(ownerEvent.dedupeKey).toBe(
      "booking-cancelled:booking-1:fleet-owner:2026-05-09T12:00:00.000Z",
    );
  });

  // Issue 5A: customer inbox must persist even with no delivery channels.
  it("emits the customer inbox row even when no customer jobData", async () => {
    notificationService.buildBookingCancellationJobData.mockResolvedValueOnce({
      customer: null,
      owner: ownerJobData,
    });
    const booking = createBooking({
      id: "booking-1",
      userId: "user-1",
      user: createUser({ id: "user-1" }),
      car: createCar({ owner: createOwner() }),
      cancelledAt: new Date("2026-05-09T12:00:00Z"),
    });

    const events = await handler.buildEvents({ booking });

    expect(events).toHaveLength(2);
    const customerEvent = events.find((e) => e.subtype === "BOOKING_CANCELLED_CUSTOMER");
    expect(customerEvent).toBeDefined();
    expect(customerEvent?.jobData).toBeUndefined();
    expect(customerEvent?.inbox).toBeDefined();
  });

  it("falls back to booking.updatedAt when cancelledAt is missing", async () => {
    notificationService.buildBookingCancellationJobData.mockResolvedValueOnce({
      customer: customerJobData,
      owner: null,
    });
    const updatedAt = new Date("2026-05-09T13:30:00Z");
    const booking = createBooking({
      id: "booking-1",
      userId: "user-1",
      user: createUser({ id: "user-1" }),
      car: createCar({ owner: createOwner() }),
      cancelledAt: null,
      updatedAt,
    });

    const [customerEvent] = await handler.buildEvents({ booking });

    expect(customerEvent.dedupeKey).toBe(
      "booking-cancelled:booking-1:client:2026-05-09T13:30:00.000Z",
    );
  });

  it("skips the customer event entirely for a guest booking with no customer jobData", async () => {
    notificationService.buildBookingCancellationJobData.mockResolvedValueOnce({
      customer: null,
      owner: ownerJobData,
    });
    const booking = createBooking({
      userId: null,
      user: null,
      car: createCar({ owner: createOwner() }),
      cancelledAt: new Date(),
    });

    const events = await handler.buildEvents({ booking });

    expect(events).toHaveLength(1);
    expect(events[0].subtype).toBe("BOOKING_CANCELLED_OWNER");
  });

  it("skips the owner event when there is no owner jobData", async () => {
    notificationService.buildBookingCancellationJobData.mockResolvedValueOnce({
      customer: customerJobData,
      owner: null,
    });
    const booking = createBooking({
      userId: "user-1",
      user: createUser({ id: "user-1" }),
      car: createCar({ owner: createOwner() }),
      cancelledAt: new Date(),
    });

    const events = await handler.buildEvents({ booking });

    expect(events).toHaveLength(1);
    expect(events[0].subtype).toBe("BOOKING_CANCELLED_CUSTOMER");
  });
});
