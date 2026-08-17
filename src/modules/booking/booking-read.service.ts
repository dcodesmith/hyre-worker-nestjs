import { Injectable } from "@nestjs/common";
import { BookingStatus, PaymentAttemptStatus, PaymentStatus } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { FLEET_OWNER, USER } from "../auth/auth.const";
import type { AuthSession } from "../auth/guards/session.guard";
import { DatabaseService } from "../database/database.service";
import { BOOKING_PAYMENT_STATUS_TOKEN_GRACE_MS } from "./booking.const";
import {
  BookingException,
  BookingFetchFailedException,
  BookingNotFoundException,
} from "./booking.error";
import type {
  BookingPaymentLifecycleState,
  BookingPaymentStatusResponse,
} from "./booking.interface";
import { getDatabaseNow } from "./booking-modification-policy.helper";
import type { BookingModificationPolicyInput } from "./booking-modification-policy.interface";
import { BookingModificationPolicyService } from "./booking-modification-policy.service";
import { matchesBookingPaymentStatusToken } from "./booking-payment-status-token.helper";
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
    private readonly bookingModificationPolicyService: BookingModificationPolicyService,
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
            in: [
              PaymentStatus.PAID,
              PaymentStatus.REFUND_PROCESSING,
              PaymentStatus.PARTIALLY_REFUNDED,
              PaymentStatus.REFUNDED,
            ],
          },
        },
        include: this.bookingDetailsInclude,
        orderBy: { startDate: "asc" },
      });

      const policyNow = await getDatabaseNow(this.databaseService);
      const serializedBookings = bookings.map((booking) =>
        this.withModificationEligibility(booking, true, policyNow),
      );

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

  async getBookingById(bookingId: string, sessionUser: AuthSession["user"]) {
    try {
      const canAccessAsBooker = sessionUser.roles.includes(USER);
      const canAccessAsFleetOwner = sessionUser.roles.includes(FLEET_OWNER);

      if (!canAccessAsBooker && !canAccessAsFleetOwner) {
        throw new BookingNotFoundException();
      }

      const ownershipFilters = [
        ...(canAccessAsBooker ? [{ userId: sessionUser.id }] : []),
        ...(canAccessAsFleetOwner ? [{ car: { ownerId: sessionUser.id } }] : []),
      ];

      const booking = await this.databaseService.booking.findFirst({
        where: {
          id: bookingId,
          OR: ownershipFilters,
        },
        include: this.bookingDetailsInclude,
      });

      if (!booking) {
        throw new BookingNotFoundException();
      }

      const policyNow = await getDatabaseNow(this.databaseService);
      return this.withModificationEligibility(
        booking,
        booking.userId === sessionUser.id,
        policyNow,
      );
    } catch (error) {
      if (error instanceof BookingException) {
        throw error;
      }

      this.logger.error(
        {
          bookingId,
          userId: sessionUser.id,
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
    paymentStatusToken?: string,
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
          totalAmount: true,
          paymentSessionExpiresAt: true,
          paymentStatusTokenHash: true,
          customerPayments: {
            where: { txRef: query.txRef },
            orderBy: { initiatedAt: "desc" },
            take: 1,
            select: { status: true },
          },
        },
      });

      if (!booking) {
        throw new BookingNotFoundException();
      }

      this.assertPaymentStatusAccess(booking, sessionUser, paymentStatusToken);
      const paymentAttemptStatus = booking.customerPayments[0]?.status;
      const lifecycleState = this.resolvePaymentLifecycleState(
        booking.status,
        booking.paymentStatus,
        paymentAttemptStatus,
        booking.paymentSessionExpiresAt,
      );

      return {
        bookingId: booking.id,
        bookingReference: booking.bookingReference,
        txRef: booking.paymentIntent ?? query.txRef,
        bookingStatus: booking.status,
        paymentStatus: booking.paymentStatus,
        paymentId: booking.paymentId ?? null,
        totalAmount: booking.totalAmount.toNumber(),
        reservationExpiresAt: booking.paymentSessionExpiresAt?.toISOString() ?? null,
        lifecycleState,
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

  private assertPaymentStatusAccess(
    booking: {
      userId: string | null;
      paymentSessionExpiresAt: Date | null;
      paymentStatusTokenHash: string | null;
    },
    sessionUser: AuthSession["user"] | null,
    paymentStatusToken?: string,
  ): void {
    if (paymentStatusToken) {
      const tokenExpiresAt =
        (booking.paymentSessionExpiresAt?.getTime() ?? 0) + BOOKING_PAYMENT_STATUS_TOKEN_GRACE_MS;
      if (
        Date.now() >= tokenExpiresAt ||
        !matchesBookingPaymentStatusToken(paymentStatusToken, booking.paymentStatusTokenHash)
      ) {
        throw new BookingNotFoundException();
      }
      return;
    }

    if (sessionUser) {
      if (!booking.userId || booking.userId !== sessionUser.id) {
        throw new BookingNotFoundException();
      }
      return;
    }

    throw new BookingNotFoundException();
  }

  private resolvePaymentLifecycleState(
    bookingStatus: BookingStatus,
    paymentStatus: PaymentStatus,
    paymentAttemptStatus: PaymentAttemptStatus | undefined,
    paymentSessionExpiresAt: Date | null,
  ): BookingPaymentLifecycleState {
    const isConfirmed =
      paymentStatus === PaymentStatus.PAID &&
      (bookingStatus === BookingStatus.CONFIRMED ||
        bookingStatus === BookingStatus.ACTIVE ||
        bookingStatus === BookingStatus.COMPLETED);
    if (isConfirmed) return "CONFIRMED";
    if (bookingStatus === BookingStatus.CANCELLED) {
      return "EXPIRED";
    }
    if (
      bookingStatus === BookingStatus.PENDING &&
      paymentStatus === PaymentStatus.UNPAID &&
      paymentSessionExpiresAt !== null &&
      paymentSessionExpiresAt <= new Date()
    ) {
      return "VERIFYING";
    }
    if (
      bookingStatus === BookingStatus.REJECTED ||
      paymentAttemptStatus === PaymentAttemptStatus.FAILED
    ) {
      return "FAILED";
    }
    return "PENDING";
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

  private withModificationEligibility<T extends BookingModificationPolicyInput>(
    booking: T,
    canAct: boolean,
    now: Date,
  ) {
    return {
      ...this.serializeValue(booking),
      ...this.bookingModificationPolicyService.getEligibility(booking, canAct, now),
    };
  }
}
