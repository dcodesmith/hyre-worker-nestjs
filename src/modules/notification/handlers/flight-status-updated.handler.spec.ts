import { Test, type TestingModule } from "@nestjs/testing";
import { NotificationInboxType, NotificationOutboxEventType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBooking,
  createCar,
  createChauffeur,
  createOwner,
  createUser,
} from "../../../shared/helper.fixtures";
import {
  CHAUFFEUR_RECIPIENT_TYPE,
  CLIENT_RECIPIENT_TYPE,
  FLEET_OWNER_RECIPIENT_TYPE,
} from "../notification.const";
import { NotificationType } from "../notification.interface";
import { NotificationService } from "../notification.service";
import { FlightStatusUpdatedHandler } from "./flight-status-updated.handler";

describe("FlightStatusUpdatedHandler", () => {
  let handler: FlightStatusUpdatedHandler;
  let notificationService: {
    buildFlightUpdateJobData: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    notificationService = {
      buildFlightUpdateJobData: vi.fn((input) => ({
        id: `${input.type}-${input.statusEventId}-${input.booking.id}-${input.recipientType}`,
      })),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FlightStatusUpdatedHandler,
        { provide: NotificationService, useValue: notificationService },
      ],
    }).compile();

    handler = module.get(FlightStatusUpdatedHandler);
  });

  it("fans operational updates to owner and chauffeur, with selective customer pushes", async () => {
    const booking = createBooking({
      id: "booking-1",
      userId: "user-1",
      user: createUser({ id: "user-1" }),
      chauffeur: createChauffeur({ id: "chauffeur-1" }),
      car: createCar({ owner: createOwner({ id: "owner-1" }) }),
    });
    const events = await handler.buildEvents({
      statusEventId: "event-1",
      flightId: "flight-1",
      flightNumber: "BA74",
      expectedArrival: "29 Jul 2026, 4:00 PM WAT",
      pickupActivationTime: "29 Jul 2026, 4:40 PM WAT",
      arrivalLocation: "LOS, Terminal 2, Gate G2",
      bookings: [booking],
      notifications: [
        {
          type: NotificationType.FLIGHT_DELAYED,
          operationalTitle: "Pickup flight delayed",
          operationalBody: "BA74 is delayed by 45 minutes.",
          customerTitle: "Your pickup flight timing changed",
          customerBody: "We adjusted your chauffeur timing.",
        },
        {
          type: NotificationType.FLIGHT_GATE_CHANGED,
          operationalTitle: "Arrival gate updated",
          operationalBody: "BA74 will arrive at gate G2.",
        },
      ],
    });

    expect(handler.eventType).toBe(NotificationOutboxEventType.BOOKING_LIFECYCLE);
    expect(events).toHaveLength(5);
    expect(events).toContainEqual({
      jobData: {
        id: "flight-delayed-event-1-booking-1-client",
      },
      inbox: {
        userId: "user-1",
        type: NotificationInboxType.BOOKING_LIFECYCLE,
        title: "Your pickup flight timing changed",
        body: "We adjusted your chauffeur timing.",
        payload: {
          bookingId: "booking-1",
          flightId: "flight-1",
          notificationType: NotificationType.FLIGHT_DELAYED,
        },
      },
      dedupeKey: "flight-update:event-1:flight-delayed:booking-1:client",
      userId: "user-1",
      subtype: NotificationType.FLIGHT_DELAYED,
    });
    expect(events).toContainEqual({
      jobData: {
        id: "flight-gate-changed-event-1-booking-1-fleetOwner",
      },
      dedupeKey: "flight-update:event-1:flight-gate-changed:booking-1:fleetOwner",
      userId: "owner-1",
      subtype: NotificationType.FLIGHT_GATE_CHANGED,
    });
    expect(events).not.toContainEqual(
      expect.objectContaining({
        dedupeKey: "flight-update:event-1:flight-gate-changed:booking-1:client",
      }),
    );
    expect(notificationService.buildFlightUpdateJobData).toHaveBeenCalledTimes(5);
    expect(notificationService.buildFlightUpdateJobData).toHaveBeenCalledWith(
      expect.objectContaining({ recipientType: FLEET_OWNER_RECIPIENT_TYPE }),
    );
    expect(notificationService.buildFlightUpdateJobData).toHaveBeenCalledWith(
      expect.objectContaining({ recipientType: CHAUFFEUR_RECIPIENT_TYPE }),
    );
    expect(notificationService.buildFlightUpdateJobData).toHaveBeenCalledWith(
      expect.objectContaining({ recipientType: CLIENT_RECIPIENT_TYPE }),
    );
  });

  it("still alerts owner and chauffeur for a guest booking", async () => {
    const booking = createBooking({
      userId: null,
      user: null,
      chauffeur: createChauffeur({ id: "chauffeur-1" }),
      car: createCar({ owner: createOwner({ id: "owner-1" }) }),
    });

    const events = await handler.buildEvents({
      statusEventId: "event-2",
      flightId: "flight-1",
      flightNumber: "BA74",
      expectedArrival: "29 Jul 2026, 4:00 PM WAT",
      pickupActivationTime: "29 Jul 2026, 4:40 PM WAT",
      arrivalLocation: "LOS",
      bookings: [booking],
      notifications: [
        {
          type: NotificationType.FLIGHT_CANCELLED,
          operationalTitle: "Pickup flight cancelled",
          operationalBody: "Review the booking.",
          customerTitle: "Your pickup flight was cancelled",
          customerBody: "We are reviewing your booking.",
        },
      ],
    });

    expect(events).toHaveLength(2);
    expect(events.every((event) => event.inbox === undefined)).toBe(true);
    expect(events.map((event) => event.userId)).toEqual(["owner-1", "chauffeur-1"]);
  });
});
