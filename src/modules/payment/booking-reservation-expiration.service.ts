import { Injectable } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { BookingStatus, PaymentStatus } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { TIMEZONE } from "../../config/constants";
import { BOOKING_PAYMENT_SESSION_DURATION_MS } from "../booking/booking.const";
import { BookingReservationService } from "../booking/booking-reservation.service";
import { DatabaseService } from "../database/database.service";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";
import { ChargeCompletedHandler } from "./charge-completed.handler";

const EXPIRED_RESERVATION_BATCH_SIZE = 50;
const RECONCILIATION_CONCURRENCY = 5;
const EVERY_MINUTE = "* * * * *";
const FINAL_UNPAID_STATUSES = new Set(["cancelled", "failed"]);

interface ExpiredReservation {
  id: string;
  paymentIntent: string | null;
}

@Injectable()
export class BookingReservationExpirationService {
  private reconciliationInProgress = false;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly flutterwaveService: FlutterwaveService,
    private readonly bookingReservationService: BookingReservationService,
    private readonly chargeCompletedHandler: ChargeCompletedHandler,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(BookingReservationExpirationService.name);
  }

  @Cron(EVERY_MINUTE, { timeZone: TIMEZONE })
  async reconcileExpiredReservations(): Promise<number> {
    if (this.reconciliationInProgress) {
      this.logger.warn("Skipping overlapping expired-reservation reconciliation");
      return 0;
    }

    this.reconciliationInProgress = true;
    try {
      return await this.reconcileExpiredReservationBatch();
    } finally {
      this.reconciliationInProgress = false;
    }
  }

  async reconcileExpiredReservation(bookingId: string): Promise<boolean> {
    const now = new Date();
    const orphanedBefore = new Date(now.getTime() - BOOKING_PAYMENT_SESSION_DURATION_MS);
    const reservation = await this.databaseService.booking.findFirst({
      where: {
        id: bookingId,
        status: BookingStatus.PENDING,
        paymentStatus: PaymentStatus.UNPAID,
        OR: [
          { paymentSessionExpiresAt: { lte: now } },
          {
            paymentSessionExpiresAt: null,
            createdAt: { lte: orphanedBefore },
          },
        ],
      },
      select: {
        id: true,
        paymentIntent: true,
      },
    });

    if (!reservation) return false;
    return this.reconcileReservation(reservation);
  }

  private async reconcileExpiredReservationBatch(): Promise<number> {
    const now = new Date();
    const orphanedBefore = new Date(now.getTime() - BOOKING_PAYMENT_SESSION_DURATION_MS);
    const reservations = await this.databaseService.booking.findMany({
      where: {
        status: BookingStatus.PENDING,
        paymentStatus: PaymentStatus.UNPAID,
        OR: [
          { paymentSessionExpiresAt: { lte: now } },
          {
            paymentSessionExpiresAt: null,
            createdAt: { lte: orphanedBefore },
          },
        ],
      },
      select: {
        id: true,
        paymentIntent: true,
      },
      orderBy: { paymentSessionExpiresAt: "asc" },
      take: EXPIRED_RESERVATION_BATCH_SIZE,
    });

    let reconciledCount = 0;
    for (let index = 0; index < reservations.length; index += RECONCILIATION_CONCURRENCY) {
      const batch = reservations.slice(index, index + RECONCILIATION_CONCURRENCY);
      const reconciled = await Promise.all(
        batch.map((reservation) => this.reconcileReservation(reservation)),
      );
      reconciledCount += reconciled.filter(Boolean).length;
    }

    return reconciledCount;
  }

  private async reconcileReservation(reservation: ExpiredReservation): Promise<boolean> {
    const paymentReferences = reservation.paymentIntent
      ? [reservation.paymentIntent]
      : [reservation.id, `booking_${reservation.id}`];

    try {
      const transaction = await this.findTransaction(paymentReferences);
      if (transaction?.status.trim().toLowerCase() === "successful") {
        await this.chargeCompletedHandler.handle({
          id: transaction.id,
          tx_ref: transaction.tx_ref,
          flw_ref: transaction.flw_ref,
          amount: transaction.amount,
          charged_amount: transaction.charged_amount,
          currency: transaction.currency,
          status: transaction.status,
          payment_type: transaction.payment_type ?? "unknown",
          created_at: transaction.created_at,
        });
        return true;
      }

      if (
        transaction === null ||
        FINAL_UNPAID_STATUSES.has(transaction.status.trim().toLowerCase())
      ) {
        return this.bookingReservationService.cancelExpiredReservation(reservation.id);
      }
      // Any other provider status is non-terminal. Keep the slot reserved and
      // retry on the next run rather than risk releasing a successfully paid car.
      return false;
    } catch (error) {
      this.logger.warn(
        {
          bookingId: reservation.id,
          paymentReferences,
          error: error instanceof Error ? error.message : String(error),
        },
        "Retaining expired reservation while payment status is uncertain",
      );
      return false;
    }
  }

  private async findTransaction(
    paymentReferences: string[],
  ): Promise<Awaited<ReturnType<FlutterwaveService["findTransactionByReference"]>>> {
    for (const paymentReference of paymentReferences) {
      const transaction =
        await this.flutterwaveService.findTransactionByReference(paymentReference);
      if (transaction) return transaction;
    }
    return null;
  }
}
