import { Test, type TestingModule } from "@nestjs/testing";
import { NotificationInboxType, NotificationOutboxEventType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBooking, createCar, createOwner, createUser } from "../../../shared/helper.fixtures";
import { NotificationService } from "../notification.service";
import { ChauffeurAssignedHandler } from "./chauffeur-assigned.handler";

const sampleJobData = {
  id: "chauffeur-assigned-booking-1-1",
  type: "chauffeur-assigned" as const,
  channels: ["email" as const],
  bookingId: "booking-1",
  recipients: { client: { email: "j@x.com" } },
  templateData: {},
};

describe("ChauffeurAssignedHandler", () => {
  let handler: ChauffeurAssignedHandler;
  let notificationService: { buildChauffeurAssignedJobData: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    notificationService = { buildChauffeurAssignedJobData: vi.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChauffeurAssignedHandler,
        { provide: NotificationService, useValue: notificationService },
      ],
    }).compile();

    handler = module.get(ChauffeurAssignedHandler);
  });

  it("uses BOOKING_ASSIGNMENT eventType", () => {
    expect(handler.eventType).toBe(NotificationOutboxEventType.BOOKING_ASSIGNMENT);
  });

  it("emits inbox + outbox + deterministic dedupeKey for a registered customer with channels", async () => {
    notificationService.buildChauffeurAssignedJobData.mockResolvedValueOnce(sampleJobData);
    const booking = createBooking({
      id: "booking-1",
      userId: "user-1",
      user: createUser({ id: "user-1" }),
      car: createCar({ make: "Toyota", model: "Camry", year: 2024, owner: createOwner() }),
      updatedAt: new Date("2026-05-09T10:00:00Z"),
    });

    const events = await handler.buildEvents({ booking, chauffeurId: "chauffeur-9" });

    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event.subtype).toBe("CHAUFFEUR_ASSIGNED");
    expect(event.userId).toBe("user-1");
    expect(event.dedupeKey).toBe(
      "chauffeur-assigned:booking-1:chauffeur-9:2026-05-09T10:00:00.000Z",
    );
    expect(event.jobData).toBe(sampleJobData);
    expect(event.inbox).toEqual({
      userId: "user-1",
      type: NotificationInboxType.BOOKING_ASSIGNMENT,
      title: "Your chauffeur has been assigned",
      body: "Your chauffeur for Toyota Camry (2024) has been assigned.",
      payload: { bookingId: "booking-1", chauffeurId: "chauffeur-9" },
    });
  });

  // Issue 5A: inbox is in-app state, dispatched delivery is independent.
  it("still emits the inbox row when buildChauffeurAssignedJobData returns null", async () => {
    notificationService.buildChauffeurAssignedJobData.mockResolvedValueOnce(null);
    const booking = createBooking({
      userId: "user-2",
      user: createUser({ id: "user-2" }),
      car: createCar({ make: "Honda", model: "Civic", year: 2023, owner: createOwner() }),
    });

    const events = await handler.buildEvents({ booking, chauffeurId: "chauffeur-x" });

    expect(events).toHaveLength(1);
    expect(events[0].jobData).toBeUndefined();
    expect(events[0].inbox).toBeDefined();
    expect(events[0].userId).toBe("user-2");
  });

  it("emits only the outbox row for a guest booking (no userId) with channels", async () => {
    notificationService.buildChauffeurAssignedJobData.mockResolvedValueOnce(sampleJobData);
    const booking = createBooking({
      userId: null,
      user: null,
      car: createCar({ owner: createOwner() }),
    });

    const events = await handler.buildEvents({ booking, chauffeurId: "chauffeur-x" });

    expect(events).toHaveLength(1);
    expect(events[0].userId).toBeNull();
    expect(events[0].inbox).toBeUndefined();
    expect(events[0].jobData).toBe(sampleJobData);
  });

  it("emits nothing when there's no userId and no jobData", async () => {
    notificationService.buildChauffeurAssignedJobData.mockResolvedValueOnce(null);
    const booking = createBooking({
      userId: null,
      user: null,
      car: createCar({ owner: createOwner() }),
    });

    const events = await handler.buildEvents({ booking, chauffeurId: "chauffeur-x" });

    expect(events).toEqual([]);
  });
});
