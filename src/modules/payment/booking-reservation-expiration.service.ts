import { Injectable } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { BookingStatus, PaymentStatus } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { TIMEZONE } from "../../config/constants";
import { BookingReservationService } from "../booking/booking-reservation.service";
import { DatabaseService } from "../database/database.service";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";
import { ChargeCompletedHandler } from "./charge-completed.handler";

const EXPIRED_RESERVATION_BATCH_SIZE = 50;
const EVERY_MINUTE = "* * * * *";
const FINAL_UNPAID_STATUSES = new Set(["cancelled", "failed"]);

@Injectable()
export class BookingReservationExpirationService {
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
    const reservations = await this.databaseService.booking.findMany({
      where: {
        status: BookingStatus.PENDING,
        paymentStatus: PaymentStatus.UNPAID,
        paymentSessionExpiresAt: { lte: new Date() },
      },
      select: {
        id: true,
        paymentIntent: true,
      },
      orderBy: { paymentSessionExpiresAt: "asc" },
      take: EXPIRED_RESERVATION_BATCH_SIZE,
    });

    let reconciledCount = 0;
    for (const reservation of reservations) {
      if (!reservation.paymentIntent) continue;

      try {
        const transaction = await this.flutterwaveService.findTransactionByReference(
          reservation.paymentIntent,
        );
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
          reconciledCount += 1;
          continue;
        }

        if (
          transaction === null ||
          FINAL_UNPAID_STATUSES.has(transaction.status.trim().toLowerCase())
        ) {
          const cancelled = await this.bookingReservationService.cancelExpiredReservation(
            reservation.id,
          );
          if (cancelled) reconciledCount += 1;
        }
        // Any other provider status is non-terminal. Keep the slot reserved and
        // retry on the next run rather than risk releasing a successfully paid car.
      } catch (error) {
        this.logger.warn(
          {
            bookingId: reservation.id,
            txRef: reservation.paymentIntent,
            error: error instanceof Error ? error.message : String(error),
          },
          "Retaining expired reservation while payment status is uncertain",
        );
      }
    }

    return reconciledCount;
  }
}
