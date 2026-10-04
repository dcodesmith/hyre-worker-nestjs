import { Injectable } from "@nestjs/common";
import { BookingStatus, ChauffeurApprovalStatus, PaymentStatus, Prisma } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { DatabaseService } from "../database/database.service";
import { isAssignableBookingPaymentStatus } from "./booking.const";
import {
  BookingException,
  BookingFetchFailedException,
  BookingNotFoundException,
} from "./booking.error";
import { availableFleetChauffeurWhere } from "./booking-chauffeur-availability";
import type { FleetOwnerBookingsQueryDto } from "./dto/fleet-owner-bookings.dto";

const fleetBookingSelect = Prisma.validator<Prisma.BookingSelect>()({
  id: true,
  bookingReference: true,
  status: true,
  paymentStatus: true,
  type: true,
  startDate: true,
  endDate: true,
  pickupLocation: true,
  returnLocation: true,
  specialRequests: true,
  flightNumber: true,
  guestUser: true,
  user: { select: { name: true } },
  car: {
    select: {
      id: true,
      make: true,
      model: true,
      year: true,
      registrationNumber: true,
    },
  },
  chauffeur: {
    select: {
      id: true,
      name: true,
      image: true,
    },
  },
});

type FleetBooking = Prisma.BookingGetPayload<{ select: typeof fleetBookingSelect }>;

@Injectable()
export class FleetOwnerBookingReadService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(FleetOwnerBookingReadService.name);
  }

  async list(ownerId: string, query: FleetOwnerBookingsQueryDto) {
    try {
      const where = {
        deletedAt: null,
        paymentStatus: { not: PaymentStatus.UNPAID },
        car: { ownerId },
      } satisfies Prisma.BookingWhereInput;
      const [items, total] = await Promise.all([
        this.databaseService.booking.findMany({
          where,
          select: fleetBookingSelect,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
        this.databaseService.booking.count({ where }),
      ]);

      return {
        items: items.map((booking) => this.toBooking(booking)),
        meta: {
          page: query.page,
          limit: query.limit,
          total,
          totalPages: Math.ceil(total / query.limit),
        },
      };
    } catch (error) {
      this.handleError(error, { ownerId }, "Failed to fetch fleet-owner bookings");
    }
  }

  async get(ownerId: string, bookingId: string) {
    try {
      const booking = await this.databaseService.booking.findFirst({
        where: {
          id: bookingId,
          deletedAt: null,
          paymentStatus: { not: PaymentStatus.UNPAID },
          car: { ownerId },
        },
        select: fleetBookingSelect,
      });

      if (!booking) {
        throw new BookingNotFoundException();
      }

      const assignableChauffeurs = this.canAssignChauffeur(booking)
        ? await this.databaseService.user.findMany({
            where: {
              ...availableFleetChauffeurWhere({
                bookingId: booking.id,
                endDate: booking.endDate,
                ownerId,
                startDate: booking.startDate,
              }),
              chauffeurApprovalStatus: ChauffeurApprovalStatus.APPROVED,
            },
            select: {
              id: true,
              name: true,
              image: true,
              isOwnerDriver: true,
            },
            orderBy: [{ name: "asc" }, { id: "asc" }],
          })
        : [];

      return {
        booking: this.toBooking(booking),
        assignableChauffeurs,
      };
    } catch (error) {
      this.handleError(error, { bookingId, ownerId }, "Failed to fetch fleet-owner booking");
    }
  }

  private toBooking(booking: FleetBooking) {
    return {
      id: booking.id,
      bookingReference: booking.bookingReference,
      status: booking.status,
      type: booking.type,
      startDate: booking.startDate,
      endDate: booking.endDate,
      pickupLocation: booking.pickupLocation,
      returnLocation: booking.returnLocation,
      specialRequests: booking.specialRequests,
      flightNumber: booking.flightNumber,
      customerName: booking.user?.name?.trim() || this.guestName(booking.guestUser) || "Customer",
      car: booking.car,
      chauffeur: booking.chauffeur,
      canAssignChauffeur: this.canAssignChauffeur(booking),
    };
  }

  private canAssignChauffeur(booking: FleetBooking): boolean {
    return (
      booking.status === BookingStatus.CONFIRMED &&
      isAssignableBookingPaymentStatus(booking.paymentStatus)
    );
  }

  private guestName(value: Prisma.JsonValue): string | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const name = (value as Prisma.JsonObject).name;
    return typeof name === "string" && name.trim() ? name.trim() : null;
  }

  private handleError(error: unknown, context: object, message: string): never {
    if (error instanceof BookingException) {
      throw error;
    }
    this.logger.error(
      {
        ...context,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      message,
    );
    throw new BookingFetchFailedException();
  }
}
