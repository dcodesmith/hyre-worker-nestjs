import { Injectable } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { BookingStatus, type Payment, PaymentAttemptStatus, PaymentStatus } from "@prisma/client";
import Decimal from "decimal.js";
import { PinoLogger } from "nestjs-pino";
import { EVERY_HOUR, TIMEZONE } from "../../config/constants";
import { BookingConfirmationService } from "../booking/booking-confirmation.service";
import { DatabaseService } from "../database/database.service";

const RECONCILIATION_GRACE_PERIOD_MS = 5 * 60 * 1000;
const RECONCILIATION_BATCH_SIZE = 50;
const MONEY_TOLERANCE = new Decimal(0.01);

@Injectable()
export class BookingPaymentReconciliationService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly bookingConfirmationService: BookingConfirmationService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(BookingPaymentReconciliationService.name);
  }

  @Cron(EVERY_HOUR, { timeZone: TIMEZONE })
  async reconcilePendingBookings(): Promise<number> {
    const confirmedBefore = new Date(Date.now() - RECONCILIATION_GRACE_PERIOD_MS);
    let payments: Payment[];

    try {
      payments = await this.databaseService.payment.findMany({
        where: {
          status: PaymentAttemptStatus.SUCCESSFUL,
          bookingId: { not: null },
          confirmedAt: { lte: confirmedBefore },
          booking: {
            is: {
              status: BookingStatus.PENDING,
              paymentStatus: PaymentStatus.UNPAID,
              deletedAt: null,
            },
          },
        },
        orderBy: { confirmedAt: "asc" },
        take: RECONCILIATION_BATCH_SIZE,
      });
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to load paid bookings for reconciliation",
      );
      return 0;
    }

    let reconciledCount = 0;
    for (const payment of payments) {
      if (!this.isEligibleForConfirmation(payment)) {
        continue;
      }

      try {
        if (await this.bookingConfirmationService.confirmFromPayment(payment)) {
          reconciledCount += 1;
        }
      } catch (error) {
        this.logger.error(
          {
            paymentId: payment.id,
            bookingId: payment.bookingId,
            txRef: payment.txRef,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to reconcile paid booking",
        );
      }
    }

    if (reconciledCount > 0) {
      this.logger.info({ reconciledCount }, "Reconciled successful payments with pending bookings");
    }

    return reconciledCount;
  }

  private isEligibleForConfirmation(payment: Payment): boolean {
    if (!payment.amountCharged) {
      this.logIneligiblePayment(payment, "missing charged amount");
      return false;
    }

    const amountDifference = new Decimal(payment.amountCharged.toString())
      .sub(payment.amountExpected.toString())
      .abs();
    if (amountDifference.gt(MONEY_TOLERANCE)) {
      this.logIneligiblePayment(payment, "charged amount does not match expected amount");
      return false;
    }

    if (payment.currency.trim().toUpperCase() !== "NGN") {
      this.logIneligiblePayment(payment, "unsupported currency");
      return false;
    }

    return true;
  }

  private logIneligiblePayment(payment: Payment, reason: string): void {
    this.logger.warn(
      {
        paymentId: payment.id,
        bookingId: payment.bookingId,
        txRef: payment.txRef,
        reason,
      },
      "Skipping paid booking reconciliation",
    );
  }
}
