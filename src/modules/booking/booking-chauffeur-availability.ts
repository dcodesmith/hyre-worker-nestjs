import { Prisma } from "@prisma/client";
import { buildBookingConflictQueryInterval } from "../../shared/availability-buffer.helper";
import { BLOCKING_BOOKING_STATUSES } from "./booking.const";

type AvailableFleetChauffeurInput = {
  bookingId?: string;
  chauffeurId?: string;
  endDate: Date;
  ownerId: string;
  startDate: Date;
};

export function availableFleetChauffeurWhere({
  bookingId,
  chauffeurId,
  endDate,
  ownerId,
  startDate,
}: AvailableFleetChauffeurInput): Prisma.UserWhereInput {
  const { bufferedStart, bufferedEnd } = buildBookingConflictQueryInterval({
    startDate,
    endDate,
  });

  return {
    ...(chauffeurId ? { id: chauffeurId } : {}),
    OR: [{ fleetOwnerId: ownerId }, { id: ownerId, isOwnerDriver: true }],
    chauffeurDisabledAt: null,
    bookingsAsChauffeur: {
      none: {
        ...(bookingId ? { id: { not: bookingId } } : {}),
        deletedAt: null,
        status: { in: [...BLOCKING_BOOKING_STATUSES] },
        startDate: { lt: bufferedEnd },
        endDate: { gt: bufferedStart },
      },
    },
  };
}

type FleetChauffeurCapacity = {
  bookingCount: number;
  chauffeurCount: number;
};

/**
 * Chauffeur supply and overlapping trip demand for one fleet that does not
 * drive itself. Demand counts every blocking booking on the owner's cars,
 * including trips that do not yet name a chauffeur.
 */
export function fleetChauffeurCapacityQuery(
  ownerId: string,
  interval: { startDate: Date; endDate: Date },
): Prisma.Sql {
  const { bufferedStart, bufferedEnd } = buildBookingConflictQueryInterval(interval);
  return Prisma.sql`
    SELECT
      (${approvedFleetChauffeurCountSql(Prisma.sql`${ownerId}`)}) AS "chauffeurCount",
      (${overlappingFleetBookingCountSql(Prisma.sql`${ownerId}`, bufferedStart, bufferedEnd)}) AS "bookingCount"
  `;
}

/**
 * Fleets whose approved chauffeurs are already fully booked for the window.
 * Owner-drivers are omitted; their own assignment still marks them busy.
 */
export function capacityExhaustedFleetOwnersQuery(interval: {
  startDate: Date;
  endDate: Date;
}): Prisma.Sql {
  const { bufferedStart, bufferedEnd } = buildBookingConflictQueryInterval(interval);
  const ownerId = Prisma.sql`owner.id`;
  return Prisma.sql`
    SELECT owner.id
    FROM "User" owner
    WHERE owner."isOwnerDriver" = false
      AND EXISTS (
        SELECT 1 FROM "Car" car WHERE car."ownerId" = owner.id
      )
      AND (${approvedFleetChauffeurCountSql(ownerId)})
        <= (${overlappingFleetBookingCountSql(ownerId, bufferedStart, bufferedEnd)})
  `;
}

export function readFleetChauffeurCapacity(
  rows: Array<Partial<FleetChauffeurCapacity>>,
): FleetChauffeurCapacity {
  const row = rows[0];
  return {
    bookingCount: Number(row?.bookingCount ?? 0),
    chauffeurCount: Number(row?.chauffeurCount ?? 0),
  };
}

function approvedFleetChauffeurCountSql(ownerId: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    SELECT COUNT(*)::int
    FROM "User" chauffeur
    WHERE chauffeur."fleetOwnerId" = ${ownerId}
      AND chauffeur."chauffeurApprovalStatus" = 'APPROVED'::"ChauffeurApprovalStatus"
      AND chauffeur."chauffeurDisabledAt" IS NULL
  `;
}

function overlappingFleetBookingCountSql(
  ownerId: Prisma.Sql,
  bufferedStart: Date,
  bufferedEnd: Date,
): Prisma.Sql {
  const statuses = Prisma.raw(
    BLOCKING_BOOKING_STATUSES.map((status) => `'${status}'::"BookingStatus"`).join(", "),
  );
  return Prisma.sql`
    SELECT COUNT(*)::int
    FROM "Booking" booking
    INNER JOIN "Car" car ON car.id = booking."carId"
    WHERE car."ownerId" = ${ownerId}
      AND booking."deletedAt" IS NULL
      AND booking.status IN (${statuses})
      AND booking."startDate" < ${bufferedEnd}
      AND booking."endDate" > ${bufferedStart}
  `;
}
