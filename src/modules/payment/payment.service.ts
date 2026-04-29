import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import { PayoutTransaction } from "@prisma/client";
import { Queue } from "bullmq";
import { PinoLogger } from "nestjs-pino";
import { PAYOUTS_QUEUE } from "../../config/constants";
import { BookingWithRelations } from "../../types";
import { DatabaseService } from "../database/database.service";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";
import { PayoutJobData, PROCESS_PAYOUT_FOR_BOOKING } from "./payment.interface";

@Injectable()
export class PaymentService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly flutterwaveService: FlutterwaveService,
    private readonly logger: PinoLogger,
    @InjectQueue(PAYOUTS_QUEUE)
    private readonly payoutsQueue: Queue<PayoutJobData>,
  ) {
    this.logger.setContext(PaymentService.name);
  }

  private hasNoPayoutAmount(booking: BookingWithRelations): boolean {
    return !booking.fleetOwnerPayoutAmountNet || booking.fleetOwnerPayoutAmountNet.isZero();
  }

  private async getVerifiedBankDetails(booking: BookingWithRelations) {
    const fleetOwner = booking.car.owner;
    const bankDetails = await this.databaseService.bankDetails.findUnique({
      where: { userId: fleetOwner.id }, // userId is @unique
    });

    if (!bankDetails) {
      this.logger.warn(
        {
          fleetOwnerId: fleetOwner.id,
          bookingId: booking.id,
        },
        "Fleet owner has no bank details. Cannot process payout for booking",
      );
      return null;
    }

    if (!bankDetails.isVerified) {
      this.logger.warn(
        {
          fleetOwnerId: fleetOwner.id,
          bookingId: booking.id,
        },
        "Bank details for fleet owner are not verified. Cannot process payout for booking",
      );
      return null;
    }

    return bankDetails;
  }

  private getMaskedAccountDetails(bankDetails: { bankName: string; accountNumber: string }) {
    const accountMask =
      bankDetails.accountNumber.length >= 4
        ? `****${bankDetails.accountNumber.slice(-4)}`
        : "********";

    return `Bank: ${bankDetails.bankName}, Account: ${accountMask}`;
  }

  private async createOrUpdatePayoutTransaction(
    booking: BookingWithRelations,
    bankDetails: { bankName: string; accountNumber: string },
    payoutAmount: number,
  ): Promise<PayoutTransaction> {
    const fleetOwner = booking.car.owner;
    const payoutMethodDetails = this.getMaskedAccountDetails(bankDetails);

    try {
      return await this.databaseService.payoutTransaction.create({
        data: {
          fleetOwnerId: fleetOwner.id,
          bookingId: booking.id,
          amountToPay: payoutAmount,
          currency: "NGN",
          status: "PENDING_DISBURSEMENT",
          payoutMethodDetails,
        },
      });
    } catch (error) {
      const errorHasCodeProperty =
        error && typeof error === "object" && "code" in error && (error as { code: string }).code;

      if (errorHasCodeProperty !== "P2002") {
        throw error;
      }

      this.logger.info(
        {
          bookingId: booking.id,
        },
        "Payout transaction already exists for booking, fetching existing record",
      );

      const existingTransaction = await this.databaseService.payoutTransaction.findFirst({
        where: { bookingId: booking.id },
      });

      if (!existingTransaction) {
        throw new Error("Failed to fetch existing payout transaction after constraint violation");
      }

      try {
        const updatedTransaction = await this.databaseService.payoutTransaction.update({
          where: { id: existingTransaction.id },
          data: {
            amountToPay: payoutAmount,
            currency: "NGN",
            payoutMethodDetails,
          },
        });
        this.logger.info(
          {
            bookingId: booking.id,
            transactionId: updatedTransaction.id,
          },
          "Updated existing payout transaction with latest values",
        );
        return updatedTransaction;
      } catch (updateError) {
        this.logger.error(
          {
            bookingId: booking.id,
            transactionId: existingTransaction.id,
            error: updateError instanceof Error ? updateError.message : String(updateError),
          },
          "Failed to update existing payout transaction with latest values",
        );
        throw updateError;
      }
    }
  }

  private async evaluatePayoutTransactionRetriability(
    bookingId: string,
    payoutTransaction: PayoutTransaction,
  ) {
    if (payoutTransaction.status === "PROCESSING" || payoutTransaction.status === "PAID_OUT") {
      this.logger.info(
        {
          bookingId,
          status: payoutTransaction.status,
        },
        "Payout already processed or in progress for booking",
      );
      return "NON_RETRIABLE";
    }

    if (payoutTransaction.status === "FAILED") {
      this.logger.info({ bookingId }, "Retrying failed payout for booking");
    }

    return "RETRIABLE";
  }

  private extractTransferId(data: unknown): string | null {
    if (!data || typeof data !== "object" || !("id" in data)) {
      return null;
    }

    const typedData = data as { id?: unknown };
    return typedData.id != null ? String(typedData.id) : null;
  }

  private async handleSuccessfulPayout(
    bookingId: string,
    payoutTransaction: PayoutTransaction,
    payoutResultData: unknown,
  ) {
    const transferId = this.extractTransferId(payoutResultData);

    const updatedTransaction = await this.databaseService.$transaction(async (tx) => {
      const updated = await tx.payoutTransaction.update({
        where: { id: payoutTransaction.id },
        data: {
          status: "PROCESSING",
          payoutProviderReference: transferId,
        },
      });
      await tx.booking.update({
        where: { id: bookingId },
        data: { overallPayoutStatus: "PROCESSING" },
      });
      return updated;
    });

    this.logger.info(
      {
        bookingId,
        transactionId: updatedTransaction.id,
      },
      "Payout for booking initiated successfully",
    );
  }

  private extractErrorMessage(data: unknown): string {
    if (!data || typeof data !== "object" || !("message" in data)) {
      return "Unknown error from Flutterwave";
    }

    const typedData = data as { message?: unknown };
    return typeof typedData.message === "string"
      ? typedData.message
      : "Unknown error from Flutterwave";
  }

  private async handleFailedPayout(
    bookingId: string,
    payoutTransaction: PayoutTransaction,
    payoutResultData: unknown,
  ) {
    const errorMessage = this.extractErrorMessage(payoutResultData);

    await this.databaseService.$transaction(async (tx) => {
      await tx.payoutTransaction.update({
        where: { id: payoutTransaction.id },
        data: { status: "FAILED", notes: `Flutterwave initiation failed: ${errorMessage}` },
      });
      await tx.booking.update({
        where: { id: bookingId },
        data: { overallPayoutStatus: "FAILED" },
      });
    });

    this.logger.error(
      {
        bookingId,
        reason: errorMessage,
      },
      "Payout initiation for booking failed",
    );
  }

  /**
   * Initiates a payout for a completed booking.
   * It creates a PayoutTransaction record and triggers the actual payout via Flutterwave.
   */
  async initiatePayout(booking: BookingWithRelations) {
    try {
      if (this.hasNoPayoutAmount(booking)) {
        this.logger.info(
          { bookingId: booking.id },
          "Booking has no payout amount. Skipping payout",
        );
        return;
      }

      const bankDetails = await this.getVerifiedBankDetails(booking);
      if (!bankDetails) return;

      const payoutAmount = booking.fleetOwnerPayoutAmountNet.toNumber();

      const payoutTransaction = await this.createOrUpdatePayoutTransaction(
        booking,
        bankDetails,
        payoutAmount,
      );

      const statusHandlingResult = await this.evaluatePayoutTransactionRetriability(
        booking.id,
        payoutTransaction,
      );
      if (statusHandlingResult === "NON_RETRIABLE") {
        return;
      }

      // Use a deterministic reference derived from the payout transaction ID so that
      // retries for the same logical payout use the same Flutterwave reference.
      const reference = `payout_${payoutTransaction.id}`;

      const payoutResult = await this.flutterwaveService.initiatePayout({
        bankDetails: {
          bankCode: bankDetails.bankCode,
          accountNumber: bankDetails.accountNumber,
          bankName: bankDetails.bankName,
        },
        amount: payoutAmount,
        reference,
        bookingId: booking.id,
        bookingReference: booking.bookingReference,
      });

      if (payoutResult.success) {
        await this.handleSuccessfulPayout(booking.id, payoutTransaction, payoutResult.data);
      } else {
        await this.handleFailedPayout(booking.id, payoutTransaction, payoutResult.data);
      }
    } catch (error) {
      if (error instanceof Error) {
        this.logger.error(
          { error: error.message, stack: error.stack },
          "Failed to initiate payout",
        );
      } else {
        this.logger.error({ error }, "Failed to initiate payout");
      }
      throw error;
    }
  }

  /**
   * Queue payout processing for a completed booking.
   * This allows payouts to be processed asynchronously via BullMQ.
   */
  async queuePayoutForBooking(bookingId: string) {
    try {
      await this.payoutsQueue.add(
        PROCESS_PAYOUT_FOR_BOOKING,
        {
          bookingId,
          timestamp: new Date().toISOString(),
        },
        {
          jobId: `payout-${bookingId}`,
          attempts: 3,
          backoff: {
            type: "exponential",
            delay: 5000,
          },
        },
      );

      this.logger.info(`Queued payout processing for booking ${bookingId}`);
    } catch (error) {
      this.logger.error(
        {
          bookingId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to queue payout processing",
      );
      throw error;
    }
  }
}
