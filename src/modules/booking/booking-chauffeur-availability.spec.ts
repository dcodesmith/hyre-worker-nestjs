import { describe, expect, it } from "vitest";
import { buildBookingConflictQueryInterval } from "../../shared/availability-buffer.helper";
import { BLOCKING_BOOKING_STATUSES } from "./booking.const";
import { availableFleetChauffeurWhere } from "./booking-chauffeur-availability";

describe("availableFleetChauffeurWhere", () => {
  const startDate = new Date("2026-04-01T09:00:00.000Z");
  const endDate = new Date("2026-04-01T21:00:00.000Z");

  it("accepts an owner-driver or fleet chauffeur with no buffered conflict", () => {
    const { bufferedStart, bufferedEnd } = buildBookingConflictQueryInterval({
      startDate,
      endDate,
    });

    expect(
      availableFleetChauffeurWhere({
        ownerId: "owner-1",
        startDate,
        endDate,
      }),
    ).toEqual({
      OR: [{ fleetOwnerId: "owner-1" }, { id: "owner-1", isOwnerDriver: true }],
      chauffeurDisabledAt: null,
      bookingsAsChauffeur: {
        none: {
          deletedAt: null,
          status: { in: [...BLOCKING_BOOKING_STATUSES] },
          startDate: { lt: bufferedEnd },
          endDate: { gt: bufferedStart },
        },
      },
    });
  });

  it("pins a chauffeur and ignores the booking being updated", () => {
    const where = availableFleetChauffeurWhere({
      ownerId: "owner-1",
      startDate,
      endDate,
      bookingId: "booking-1",
      chauffeurId: "chauffeur-1",
    });

    expect(where).toMatchObject({
      id: "chauffeur-1",
      bookingsAsChauffeur: {
        none: expect.objectContaining({
          id: { not: "booking-1" },
        }),
      },
    });
  });
});
