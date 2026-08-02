import { Injectable } from "@nestjs/common";
import { BookingStatus, PaymentAttemptStatus, PaymentStatus, Prisma } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { DatabaseService, lockCarRow } from "../database/database.service";
import { BookingEligibilityService } from "./booking-eligibility.service";

const EXPIRED_RESERVATION_REASON = "Payment session expired";
const BOOKING_OVERLAP_CONSTRAINT = "Booking_car_active_window_excl";

@Injectable()
export class BookingReservationService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly bookingEligibilityService: BookingEligibilityService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(BookingReservationService.name);
  }

  async cancelExpiredReservation(bookingId: string): Promise<boolean> {
    const bookingIdentity = await this.databaseService.booking.findUnique({
      where: { id: bookingId },
      select: { carId: true },
    });
    if (!bookingIdentity) return false;

    return this.databaseService.$transaction(async (tx) => {
      const carExists = await lockCarRow(tx, bookingIdentity.carId);
      if (!carExists) return false;

      const [reservation] = await tx.$queryRaw<
        Array<{
          id: string;
          paymentSessionExpiresAt: Date | null;
          paymentStatus: PaymentStatus;
          status: BookingStatus;
        }>
      >(Prisma.sql`
        SELECT
          id,
          "paymentSessionExpiresAt",
          "paymentStatus",
          status
        FROM "Booking"
        WHERE id = ${bookingId}
        FOR UPDATE
      `);

      if (
        !reservation ||
        reservation.status !== BookingStatus.PENDING ||
        reservation.paymentStatus !== PaymentStatus.UNPAID ||
        !reservation.paymentSessionExpiresAt ||
        reservation.paymentSessionExpiresAt > new Date()
      ) {
        return false;
      }

      const successfulPayments = await tx.payment.count({
        where: {
          bookingId,
          status: PaymentAttemptStatus.SUCCESSFUL,
        },
      });
      if (successfulPayments > 0) {
        return false;
      }

      await this.bookingEligibilityService.releaseReferralReservation(tx, bookingId);

      const cancelled = await tx.booking.updateMany({
        where: {
          id: bookingId,
          status: BookingStatus.PENDING,
          paymentStatus: PaymentStatus.UNPAID,
          paymentSessionExpiresAt: { lte: new Date() },
        },
        data: {
          status: BookingStatus.CANCELLED,
          cancelledAt: new Date(),
          cancellationReason: EXPIRED_RESERVATION_REASON,
          referralCreditsReserved: 0,
          referralCreditsUsed: 0,
        },
      });

      if (cancelled.count === 1) {
        this.logger.info({ bookingId }, "Cancelled expired booking reservation");
        return true;
      }
      return false;
    });
  }

  isOverlapConstraintViolation(error: unknown): boolean {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      const metadata = JSON.stringify(error.meta ?? {});
      return (
        (error.code === "P2002" || error.code === "P2004") &&
        metadata.includes(BOOKING_OVERLAP_CONSTRAINT)
      );
    }

    if (error instanceof Prisma.PrismaClientUnknownRequestError) {
      return (
        error.message.includes(BOOKING_OVERLAP_CONSTRAINT) ||
        error.message.includes("23P01") ||
        error.message.includes("exclusion_violation")
      );
    }

    return false;
  }
}
