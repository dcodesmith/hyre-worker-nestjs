import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { buildBookingConflictQueryInterval } from "../../shared/availability-buffer.helper";
import { BLOCKING_BOOKING_STATUSES } from "./booking.const";
import {
  availableFleetChauffeurWhere,
  capacityExhaustedFleetOwnersQuery,
  fleetChauffeurCapacityQuery,
  readFleetChauffeurCapacity,
} from "./booking-chauffeur-availability";

function isSql(value: unknown): value is Prisma.Sql {
  return (
    typeof value === "object" &&
    value !== null &&
    "strings" in value &&
    "values" in value &&
    Array.isArray(value.strings) &&
    Array.isArray(value.values)
  );
}

function flattenSql(query: Prisma.Sql): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const text = query.strings
    .map((part, index) => {
      const value = query.values[index];
      if (isSql(value)) {
        const nested = flattenSql(value);
        values.push(...nested.values);
        return part + nested.text;
      }
      if (index < query.values.length) {
        values.push(value);
        return part;
      }
      return part;
    })
    .join("");
  return { text, values };
}

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

  it("counts unassigned trips and distinct assigned chauffeurs as occupied slots", () => {
    const { bufferedStart, bufferedEnd } = buildBookingConflictQueryInterval({
      startDate,
      endDate,
    });
    const { text, values } = flattenSql(
      fleetChauffeurCapacityQuery("owner-1", { startDate, endDate }),
    );

    expect(text).toContain("chauffeurCount");
    expect(text).toContain("occupiedSlotCount");
    expect(text).toContain(`COUNT(*) FILTER (WHERE booking."chauffeurId" IS NULL)`);
    expect(text).toContain(`COUNT(DISTINCT booking."chauffeurId")`);
    expect(text).toContain(`'APPROVED'::"ChauffeurApprovalStatus"`);
    expect(text).toContain(`'PENDING'::"BookingStatus"`);
    expect(text).toContain(`'CONFIRMED'::"BookingStatus"`);
    expect(text).toContain(`'ACTIVE'::"BookingStatus"`);
    expect(text).toContain(`chauffeur."chauffeurDisabledAt" IS NULL`);
    expect(values).toEqual(expect.arrayContaining(["owner-1", bufferedEnd, bufferedStart]));
  });

  it("finds non-driving fleets with no chauffeur capacity left", () => {
    const { text } = flattenSql(capacityExhaustedFleetOwnersQuery({ startDate, endDate }));

    expect(text).toContain(`owner."isOwnerDriver" = false`);
    expect(text).toContain("<=");
    expect(text).toContain(`'APPROVED'::"ChauffeurApprovalStatus"`);
    expect(text).not.toContain("chauffeurCount");
  });

  it("reads missing capacity counts as zero", () => {
    expect(readFleetChauffeurCapacity([])).toEqual({
      chauffeurCount: 0,
      occupiedSlotCount: 0,
    });
    expect(readFleetChauffeurCapacity([{ chauffeurCount: 3, occupiedSlotCount: 2 }])).toEqual({
      chauffeurCount: 3,
      occupiedSlotCount: 2,
    });
  });
});
