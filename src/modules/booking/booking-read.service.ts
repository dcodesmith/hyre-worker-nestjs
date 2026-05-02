import { Injectable } from "@nestjs/common";
import { PaymentStatus } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import type { AuthSession } from "../auth/guards/session.guard";
import { DatabaseService } from "../database/database.service";
import {
  BookingException,
  BookingFetchFailedException,
  BookingNotFoundException,
} from "./booking.error";
import type { BookingPaymentStatusResponse } from "./booking.interface";
import type { BookingPaymentStatusQueryDto } from "./dto/get-booking-payment-status.dto";

@Injectable()
export class BookingReadService {
  private readonly bookingDetailsInclude = {
    car: { include: { owner: true, images: true } },
    user: true,
    chauffeur: true,
    flight: true,
    review: {
      include: {
        user: {
          select: {
            id: true,
            name: true,
            image: true,
          },
        },
      },
    },
    legs: {
      orderBy: { legDate: "asc" },
      include: {
        extensions: true,
      },
    },
  } as const;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(BookingReadService.name);
  }

  async getBookingsByStatus(userId: string) {
    try {
      const bookings = await this.databaseService.booking.findMany({
        where: {
          userId,
          paymentStatus: {
            in: [PaymentStatus.PAID, PaymentStatus.PARTIALLY_REFUNDED, PaymentStatus.REFUNDED],
          },
        },
        include: this.bookingDetailsInclude,
        orderBy: { startDate: "asc" },
      });

      const serializedBookings = bookings.map((booking) => this.serializeValue(booking));

      return serializedBookings.reduce<Record<string, unknown[]>>((acc, booking) => {
        const status = booking.status;
        if (!acc[status]) {
          acc[status] = [];
        }
        acc[status].push(booking);
        return acc;
      }, {});
    } catch (error) {
      if (error instanceof BookingException) {
        throw error;
      }

      this.logger.error(
        {
          userId,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        "Failed to fetch bookings by status",
      );
      throw new BookingFetchFailedException();
    }
  }

  async getBookingById(bookingId: string, userId: string) {
    try {
      const booking = await this.databaseService.booking.findFirst({
        where: { id: bookingId, userId },
        include: this.bookingDetailsInclude,
      });

      if (!booking) {
        throw new BookingNotFoundException();
      }

      return this.serializeValue(booking);
    } catch (error) {
      if (error instanceof BookingException) {
        throw error;
      }

      this.logger.error(
        {
          bookingId,
          userId,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        "Failed to fetch booking by id",
      );
      throw new BookingFetchFailedException();
    }
  }

  async getBookingPaymentStatus(
    query: BookingPaymentStatusQueryDto,
    sessionUser: AuthSession["user"] | null,
  ): Promise<BookingPaymentStatusResponse> {
    try {
      const booking = await this.databaseService.booking.findFirst({
        where: {
          id: query.bookingId,
          paymentIntent: query.txRef,
        },
        select: {
          id: true,
          bookingReference: true,
          paymentIntent: true,
          paymentStatus: true,
          paymentId: true,
          status: true,
          userId: true,
          guestUser: true,
          totalAmount: true,
        },
      });

      if (!booking) {
        throw new BookingNotFoundException();
      }

      if (sessionUser) {
        if (!booking.userId || booking.userId !== sessionUser.id) {
          throw new BookingNotFoundException();
        }
      } else {
        const requestedGuestEmail = query.guestEmail?.trim().toLowerCase();
        const bookingGuestEmail = this.extractGuestEmail(booking.guestUser)?.toLowerCase();

        if (
          !requestedGuestEmail ||
          !bookingGuestEmail ||
          requestedGuestEmail !== bookingGuestEmail
        ) {
          throw new BookingNotFoundException();
        }
      }

      const isConfirmed =
        booking.paymentStatus === PaymentStatus.PAID &&
        (booking.status === "CONFIRMED" || booking.status === "ACTIVE");

      return {
        bookingId: booking.id,
        bookingReference: booking.bookingReference,
        txRef: booking.paymentIntent ?? query.txRef,
        bookingStatus: booking.status,
        paymentStatus: booking.paymentStatus,
        paymentId: booking.paymentId ?? null,
        totalAmount: booking.totalAmount.toNumber(),
        isConfirmed,
      };
    } catch (error) {
      if (error instanceof BookingException) {
        throw error;
      }

      this.logger.error(
        {
          txRef: query.txRef,
          bookingId: query.bookingId,
          userId: sessionUser?.id,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        "Failed to fetch booking payment status",
      );
      throw new BookingFetchFailedException();
    }
  }

  private extractGuestEmail(guestUser: unknown): string | undefined {
    if (guestUser && typeof guestUser === "object") {
      const email = (guestUser as { email?: unknown }).email;
      if (typeof email === "string" && email.trim()) {
        return email.trim();
      }
    }
    return undefined;
  }

  private serializeValue<T>(value: T): T {
    if (value === null || value === undefined) {
      return value;
    }

    if (value instanceof Date) {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.serializeValue(item)) as T;
    }

    if (typeof value === "object") {
      const maybeDecimal = value as { toNumber?: () => number };
      if (typeof maybeDecimal.toNumber === "function") {
        return maybeDecimal.toNumber() as T;
      }

      const serializedObject: Record<string, unknown> = {};
      for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
        serializedObject[key] = this.serializeValue(nestedValue);
      }
      return serializedObject as T;
    }

    return value;
  }
}
