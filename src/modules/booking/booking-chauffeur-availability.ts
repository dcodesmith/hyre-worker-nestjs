import type { Prisma } from "@prisma/client";
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
