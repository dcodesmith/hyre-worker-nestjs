import { Test, type TestingModule } from "@nestjs/testing";
import { NotificationInboxType, NotificationOutboxEventType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBooking, createCar, createOwner, createUser } from "../../../shared/helper.fixtures";
import type { ExtensionWithNotificationRelations } from "../../../types";
import { NotificationService } from "../notification.service";
import { BookingExtensionConfirmedHandler } from "./booking-extension-confirmed.handler";

const jobData = {
  id: "booking-extension-confirmed-extension-1",
  type: "booking-extension-confirmed" as const,
  channels: ["push" as const],
  bookingId: "booking-1",
  recipients: { client: { userId: "user-1" } },
  templateData: {},
};

function createExtension(
  booking = createBooking({
    id: "booking-1",
    userId: "user-1",
    user: createUser({ id: "user-1" }),
    car: createCar({ owner: createOwner() }),
  }),
): ExtensionWithNotificationRelations {
  return {
    id: "extension-1",
    bookingLeg: { booking },
  } as ExtensionWithNotificationRelations;
}

describe("BookingExtensionConfirmedHandler", () => {
  let handler: BookingExtensionConfirmedHandler;
  let notificationService: { buildBookingExtensionConfirmedJobData: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    notificationService = { buildBookingExtensionConfirmedJobData: vi.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingExtensionConfirmedHandler,
        { provide: NotificationService, useValue: notificationService },
      ],
    }).compile();

    handler = module.get(BookingExtensionConfirmedHandler);
  });

  it("emits a deterministic customer inbox and outbox event", async () => {
    notificationService.buildBookingExtensionConfirmedJobData.mockResolvedValueOnce(jobData);

    const events = await handler.buildEvents({ extension: createExtension() });

    expect(handler.eventType).toBe(NotificationOutboxEventType.BOOKING_LIFECYCLE);
    expect(events).toEqual([
      {
        jobData,
        dedupeKey: "booking-extension-confirmed:extension-1:client",
        userId: "user-1",
        subtype: "BOOKING_EXTENSION_CONFIRMED_CUSTOMER",
        inbox: {
          userId: "user-1",
          type: NotificationInboxType.BOOKING_LIFECYCLE,
          title: "Booking extension confirmed",
          body: "Your booking extension has been confirmed.",
          payload: {
            bookingId: "booking-1",
            extensionId: "extension-1",
            status: "ACTIVE",
          },
        },
      },
    ]);
  });

  it("keeps the customer inbox when no delivery channel is available", async () => {
    notificationService.buildBookingExtensionConfirmedJobData.mockResolvedValueOnce(null);

    const events = await handler.buildEvents({ extension: createExtension() });

    expect(events).toHaveLength(1);
    expect(events[0].inbox).toBeDefined();
    expect(events[0].jobData).toBeUndefined();
  });

  it("omits the event for a guest without delivery channels", async () => {
    notificationService.buildBookingExtensionConfirmedJobData.mockResolvedValueOnce(null);
    const booking = createBooking({ id: "booking-1", userId: null, user: null });

    await expect(handler.buildEvents({ extension: createExtension(booking) })).resolves.toEqual([]);
  });
});
