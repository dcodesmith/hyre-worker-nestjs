import { Injectable, Logger } from "@nestjs/common";
import { PaymentStatus } from "@prisma/client";
import { DatabaseService } from "../database/database.service";
import {
  BookingException,
  BookingFetchFailedException,
  BookingNotFoundException,
} from "./booking.error";

@Injectable()
export class BookingReadService {
  private readonly logger = new Logger(BookingReadService.name);
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

  constructor(private readonly databaseService: DatabaseService) {}

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

      this.logger.error("Failed to fetch bookings by status", {
        userId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
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

      this.logger.error("Failed to fetch booking by id", {
        bookingId,
        userId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw new BookingFetchFailedException();
    }
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
