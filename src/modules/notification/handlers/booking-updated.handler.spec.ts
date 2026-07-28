import { Test, type TestingModule } from "@nestjs/testing";
import { NotificationInboxType, NotificationOutboxEventType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBooking, createCar, createOwner, createUser } from "../../../shared/helper.fixtures";
import { NotificationService } from "../notification.service";
import { BookingUpdatedHandler, shouldPushBookingUpdate } from "./booking-updated.handler";

describe("BookingUpdatedHandler", () => {
  let handler: BookingUpdatedHandler;
  let notificationService: { buildBookingUpdatedJobData: ReturnType<typeof vi.fn> };

  const updatedAt = new Date("2026-07-28T18:00:00.000Z");
  const booking = createBooking({
    id: "booking-1",
    userId: "customer-1",
    user: createUser({ id: "customer-1" }),
    car: createCar({ owner: createOwner() }),
    updatedAt,
  });
  const jobData = {
    id: "booking-updated-booking-1",
    type: "booking-updated" as const,
    channels: ["email" as const],
    bookingId: "booking-1",
    recipients: { client: { userId: "customer-1" } },
    templateData: {},
  };

  beforeEach(async () => {
    notificationService = { buildBookingUpdatedJobData: vi.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingUpdatedHandler,
        { provide: NotificationService, useValue: notificationService },
      ],
    }).compile();

    handler = module.get(BookingUpdatedHandler);
  });

  it("suppresses push for the customer's own update", async () => {
    notificationService.buildBookingUpdatedJobData.mockResolvedValueOnce(jobData);

    const events = await handler.buildEvents({
      booking,
      actor: { type: "user", userId: "customer-1" },
    });

    expect(notificationService.buildBookingUpdatedJobData).toHaveBeenCalledWith(booking, false);
    expect(handler.eventType).toBe(NotificationOutboxEventType.BOOKING_LIFECYCLE);
    expect(events).toEqual([
      {
        jobData,
        dedupeKey: `booking-updated:booking-1:${updatedAt.toISOString()}`,
        userId: "customer-1",
        subtype: "BOOKING_UPDATED",
        inbox: {
          userId: "customer-1",
          type: NotificationInboxType.BOOKING_LIFECYCLE,
          title: "Booking updated",
          body: "Your booking details have been updated.",
          payload: { bookingId: "booking-1" },
        },
      },
    ]);
  });

  it.each([
    { actor: { type: "system" } as const, label: "system" },
    { actor: { type: "user", userId: "support-1" } as const, label: "another user" },
  ])("enables push for $label updates", async ({ actor }) => {
    notificationService.buildBookingUpdatedJobData.mockResolvedValueOnce(jobData);

    await handler.buildEvents({ booking, actor });

    expect(notificationService.buildBookingUpdatedJobData).toHaveBeenCalledWith(booking, true);
  });

  it("expresses the actor policy independently of delivery channels", () => {
    expect(shouldPushBookingUpdate({ type: "user", userId: "customer-1" }, "customer-1")).toBe(
      false,
    );
    expect(shouldPushBookingUpdate({ type: "system" }, "customer-1")).toBe(true);
  });
});
