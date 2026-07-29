import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { BookingStatus, PayoutTransaction, PayoutTransactionStatus } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { BookingWithRelations } from "../../types";
import { DatabaseService } from "../database/database.service";
import type { PayoutResponse } from "../flutterwave/flutterwave.interface";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";
import {
  PayoutBankDetailsRequiredException,
  PayoutBookingNotCompletedException,
  PayoutBookingNotFoundException,
  PayoutInitiationFailedException,
  PayoutProcessingClaimLostException,
  PayoutProcessingInProgressException,
  PayoutTransactionRecoveryFailedException,
} from "./payment.error";

const PAYOUT_PROCESSING_LEASE_MS = 10 * 60 * 1000;

@Injectable()
export class PaymentService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly flutterwaveService: FlutterwaveService,
    private readonly logger: PinoLogger,
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
        throw new PayoutTransactionRecoveryFailedException(booking.id);
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

  private async claimPayoutProcessing(
    bookingId: string,
    payoutTransaction: PayoutTransaction,
  ): Promise<string | null> {
    if (
      payoutTransaction.status === PayoutTransactionStatus.PAID_OUT ||
      (payoutTransaction.status === PayoutTransactionStatus.PROCESSING &&
        !payoutTransaction.processingLeaseId)
    ) {
      this.logger.info(
        {
          bookingId,
          status: payoutTransaction.status,
        },
        "Payout already processed or in progress for booking",
      );
      return null;
    }

    if (payoutTransaction.status === PayoutTransactionStatus.FAILED) {
      this.logger.info({ bookingId }, "Retrying failed payout for booking");
    }

    const now = new Date();
    const processingLeaseId = randomUUID();
    const claimed = await this.databaseService.payoutTransaction.updateMany({
      where: {
        id: payoutTransaction.id,
        OR: [
          {
            status: {
              in: [PayoutTransactionStatus.PENDING_DISBURSEMENT, PayoutTransactionStatus.FAILED],
            },
          },
          {
            status: PayoutTransactionStatus.PROCESSING,
            processingLeaseExpiresAt: { lte: now },
          },
        ],
      },
      data: {
        status: PayoutTransactionStatus.PROCESSING,
        initiatedAt: now,
        processingLeaseId,
        processingLeaseExpiresAt: new Date(now.getTime() + PAYOUT_PROCESSING_LEASE_MS),
      },
    });

    if (claimed.count === 0) {
      throw new PayoutProcessingInProgressException(bookingId);
    }

    return processingLeaseId;
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
    processingLeaseId: string,
  ): Promise<void> {
    const transferId = this.extractTransferId(payoutResultData);

    await this.databaseService.$transaction(async (tx) => {
      const updated = await tx.payoutTransaction.updateMany({
        where: {
          id: payoutTransaction.id,
          status: PayoutTransactionStatus.PROCESSING,
          processingLeaseId,
        },
        data: {
          status: PayoutTransactionStatus.PROCESSING,
          payoutProviderReference: transferId,
          processingLeaseId: null,
          processingLeaseExpiresAt: null,
        },
      });
      if (updated.count === 0) {
        throw new PayoutProcessingClaimLostException(bookingId);
      }

      await tx.booking.update({
        where: { id: bookingId },
        data: { overallPayoutStatus: "PROCESSING" },
      });
    });

    this.logger.info(
      {
        bookingId,
        transactionId: payoutTransaction.id,
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
    errorMessage: string,
    processingLeaseId: string,
  ): Promise<void> {
    await this.databaseService.$transaction(async (tx) => {
      const updated = await tx.payoutTransaction.updateMany({
        where: {
          id: payoutTransaction.id,
          status: PayoutTransactionStatus.PROCESSING,
          processingLeaseId,
        },
        data: {
          status: PayoutTransactionStatus.FAILED,
          notes: `Flutterwave initiation failed: ${errorMessage}`,
          processingLeaseId: null,
          processingLeaseExpiresAt: null,
        },
      });
      if (updated.count === 0) {
        return;
      }

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
  async initiatePayout(booking: BookingWithRelations): Promise<void> {
    try {
      if (this.hasNoPayoutAmount(booking)) {
        this.logger.info(
          { bookingId: booking.id },
          "Booking has no payout amount. Skipping payout",
        );
        return;
      }

      const bankDetails = await this.getVerifiedBankDetails(booking);
      if (!bankDetails) {
        throw new PayoutBankDetailsRequiredException(booking.id);
      }

      const payoutAmount = booking.fleetOwnerPayoutAmountNet.toNumber();

      const payoutTransaction = await this.createOrUpdatePayoutTransaction(
        booking,
        bankDetails,
        payoutAmount,
      );

      const processingLeaseId = await this.claimPayoutProcessing(booking.id, payoutTransaction);
      if (!processingLeaseId) {
        return;
      }

      // Use a deterministic reference derived from the payout transaction ID so that
      // retries for the same logical payout use the same Flutterwave reference.
      const reference = `payout_${payoutTransaction.id}`;

      let payoutResult: PayoutResponse;
      try {
        payoutResult = await this.flutterwaveService.initiatePayout({
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
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await this.handleFailedPayout(booking.id, payoutTransaction, reason, processingLeaseId);
        throw new PayoutInitiationFailedException(booking.id, reason);
      }

      if (payoutResult.success) {
        await this.handleSuccessfulPayout(
          booking.id,
          payoutTransaction,
          payoutResult.data,
          processingLeaseId,
        );
      } else {
        const reason = this.extractErrorMessage(payoutResult.data);
        await this.handleFailedPayout(booking.id, payoutTransaction, reason, processingLeaseId);
        throw new PayoutInitiationFailedException(booking.id, reason);
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

  async processPayoutForBooking(bookingId: string): Promise<void> {
    const booking = await this.databaseService.booking.findUnique({
      where: { id: bookingId },
      include: {
        chauffeur: true,
        user: true,
        car: { include: { owner: true } },
        legs: {
          include: {
            extensions: true,
          },
        },
      },
    });

    if (!booking) {
      throw new PayoutBookingNotFoundException(bookingId);
    }

    if (booking.status !== BookingStatus.COMPLETED) {
      throw new PayoutBookingNotCompletedException(bookingId);
    }

    await this.initiatePayout(booking);
  }
}
