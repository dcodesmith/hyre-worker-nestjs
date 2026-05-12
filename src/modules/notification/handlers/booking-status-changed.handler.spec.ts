import { Test, type TestingModule } from "@nestjs/testing";
import { NotificationInboxType, NotificationOutboxEventType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBooking, createCar, createOwner, createUser } from "../../../shared/helper.fixtures";
import { NotificationService } from "../notification.service";
import { BookingStatusChangedHandler } from "./booking-status-changed.handler";

const sampleJobData = {
  id: "booking-status-change-booking-1-1",
  type: "booking-status-change" as const,
  channels: ["email" as const],
  bookingId: "booking-1",
  recipients: { client: { email: "j@x.com" } },
  templateData: {},
};

describe("BookingStatusChangedHandler", () => {
  let handler: BookingStatusChangedHandler;
  let notificationService: { buildBookingStatusChangeJobData: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    notificationService = { buildBookingStatusChangeJobData: vi.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingStatusChangedHandler,
        { provide: NotificationService, useValue: notificationService },
      ],
    }).compile();

    handler = module.get(BookingStatusChangedHandler);
  });

  it("uses BOOKING_LIFECYCLE eventType", () => {
    expect(handler.eventType).toBe(NotificationOutboxEventType.BOOKING_LIFECYCLE);
  });

  it("forwards (booking, oldStatus, newStatus, showReviewRequest) to the builder", async () => {
    notificationService.buildBookingStatusChangeJobData.mockResolvedValueOnce(sampleJobData);
    const booking = createBooking({
      id: "booking-1",
      userId: "user-1",
      user: createUser({ id: "user-1" }),
      car: createCar({ owner: createOwner() }),
    });

    await handler.buildEvents({
      booking,
      oldStatus: "CONFIRMED",
      newStatus: "ACTIVE",
      showReviewRequest: true,
    });

    expect(notificationService.buildBookingStatusChangeJobData).toHaveBeenCalledWith({
      booking,
      oldStatus: "CONFIRMED",
      newStatus: "ACTIVE",
      showReviewRequest: true,
    });
  });

  it("defaults showReviewRequest to false", async () => {
    notificationService.buildBookingStatusChangeJobData.mockResolvedValueOnce(sampleJobData);
    const booking = createBooking({
      userId: "user-1",
      user: createUser({ id: "user-1" }),
      car: createCar({ owner: createOwner() }),
    });

    await handler.buildEvents({ booking, oldStatus: "CONFIRMED", newStatus: "ACTIVE" });

    expect(notificationService.buildBookingStatusChangeJobData).toHaveBeenCalledWith(
      expect.objectContaining({ showReviewRequest: false }),
    );
  });

  it("emits inbox + outbox with a deterministic dedupeKey", async () => {
    notificationService.buildBookingStatusChangeJobData.mockResolvedValueOnce(sampleJobData);
    const booking = createBooking({
      id: "booking-1",
      userId: "user-1",
      user: createUser({ id: "user-1" }),
      car: createCar({ owner: createOwner() }),
      updatedAt: new Date("2026-05-09T11:00:00Z"),
    });

    const [event] = await handler.buildEvents({
      booking,
      oldStatus: "CONFIRMED",
      newStatus: "ACTIVE",
    });

    expect(event.subtype).toBe("BOOKING_STATUS_CHANGED");
    expect(event.userId).toBe("user-1");
    expect(event.dedupeKey).toBe(
      "booking-status:booking-1:CONFIRMED:ACTIVE:2026-05-09T11:00:00.000Z",
    );
    expect(event.jobData).toBe(sampleJobData);
    expect(event.inbox).toEqual({
      userId: "user-1",
      type: NotificationInboxType.BOOKING_LIFECYCLE,
      title: "Booking status updated",
      body: "Your booking has moved from confirmed to active.",
      payload: { bookingId: booking.id, oldStatus: "CONFIRMED", newStatus: "ACTIVE" },
    });
  });

  // Issue 5A: this is the case that historically dropped the inbox row.
  it("still emits the inbox row when there are no delivery channels", async () => {
    notificationService.buildBookingStatusChangeJobData.mockResolvedValueOnce(null);
    const booking = createBooking({
      userId: "user-1",
      user: createUser({ id: "user-1" }),
      car: createCar({ owner: createOwner() }),
    });

    const events = await handler.buildEvents({
      booking,
      oldStatus: "CONFIRMED",
      newStatus: "ACTIVE",
    });

    expect(events).toHaveLength(1);
    expect(events[0].jobData).toBeUndefined();
    expect(events[0].inbox).toBeDefined();
  });

  it("emits nothing when the booking has no userId and no channels", async () => {
    notificationService.buildBookingStatusChangeJobData.mockResolvedValueOnce(null);
    const booking = createBooking({
      userId: null,
      user: null,
      car: createCar({ owner: createOwner() }),
    });

    const events = await handler.buildEvents({
      booking,
      oldStatus: "CONFIRMED",
      newStatus: "ACTIVE",
    });

    expect(events).toEqual([]);
  });
});
