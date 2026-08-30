import { Injectable } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { BookingStatus, PaymentStatus } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { TIMEZONE } from "../../config/constants";
import { BOOKING_PAYMENT_SESSION_DURATION_MS } from "../booking/booking.const";
import { BookingReservationService } from "../booking/booking-reservation.service";
import { ExtensionReservationService } from "../booking/extension-reservation.service";
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
  kind: "booking" | "extension";
}

@Injectable()
export class BookingReservationExpirationService {
  private reconciliationInProgress = false;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly flutterwaveService: FlutterwaveService,
    private readonly bookingReservationService: BookingReservationService,
    private readonly extensionReservationService: ExtensionReservationService,
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
      const bookingCount = await this.reconcileExpiredBookingBatch();
      const extensionCount = await this.reconcileExpiredExtensionBatch();
      return bookingCount + extensionCount;
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
    return this.reconcileReservation({ ...reservation, kind: "booking" });
  }

  async reconcileExpiredExtension(extensionId: string): Promise<boolean> {
    const now = new Date();
    const orphanedBefore = new Date(now.getTime() - BOOKING_PAYMENT_SESSION_DURATION_MS);
    const reservation = await this.databaseService.extension.findFirst({
      where: {
        id: extensionId,
        status: "PENDING",
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
    return this.reconcileReservation({ ...reservation, kind: "extension" });
  }

  private async reconcileExpiredBookingBatch(): Promise<number> {
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
      orderBy: [
        { paymentReconciliationCheckedAt: { sort: "asc", nulls: "first" } },
        { paymentSessionExpiresAt: "asc" },
      ],
      take: EXPIRED_RESERVATION_BATCH_SIZE,
    });

    return this.reconcileBatch(
      reservations.map((reservation) => ({ ...reservation, kind: "booking" })),
    );
  }

  private async reconcileExpiredExtensionBatch(): Promise<number> {
    const now = new Date();
    const orphanedBefore = new Date(now.getTime() - BOOKING_PAYMENT_SESSION_DURATION_MS);
    const reservations = await this.databaseService.extension.findMany({
      where: {
        status: "PENDING",
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
      orderBy: [
        { paymentReconciliationCheckedAt: { sort: "asc", nulls: "first" } },
        { paymentSessionExpiresAt: "asc" },
      ],
      take: EXPIRED_RESERVATION_BATCH_SIZE,
    });

    return this.reconcileBatch(
      reservations.map((reservation) => ({ ...reservation, kind: "extension" })),
    );
  }

  private async reconcileBatch(reservations: ExpiredReservation[]): Promise<number> {
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
      : reservation.kind === "booking"
        ? [reservation.id, `booking_${reservation.id}`]
        : [];

    try {
      await this.markReconciliationChecked(reservation);
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
        return reservation.kind === "booking"
          ? this.bookingReservationService.cancelExpiredReservation(reservation.id)
          : this.extensionReservationService.cancelExpiredReservation(reservation.id);
      }
      // Any other provider status is non-terminal. Keep the slot reserved and
      // retry on the next run rather than risk releasing a successfully paid car.
      return false;
    } catch (error) {
      this.logger.warn(
        {
          reservationId: reservation.id,
          reservationKind: reservation.kind,
          paymentReferences,
          error: error instanceof Error ? error.message : String(error),
        },
        "Retaining expired reservation while payment status is uncertain",
      );
      return false;
    }
  }

  private async markReconciliationChecked(reservation: ExpiredReservation): Promise<void> {
    const data = { paymentReconciliationCheckedAt: new Date() };
    if (reservation.kind === "booking") {
      await this.databaseService.booking.updateMany({
        where: {
          id: reservation.id,
          status: BookingStatus.PENDING,
          paymentStatus: PaymentStatus.UNPAID,
        },
        data,
      });
      return;
    }
    await this.databaseService.extension.updateMany({
      where: {
        id: reservation.id,
        status: "PENDING",
        paymentStatus: PaymentStatus.UNPAID,
      },
      data,
    });
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
