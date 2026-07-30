import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { BookingStatus, PayoutTransaction, PayoutTransactionStatus } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { BookingWithRelations } from "../../types";
import { DatabaseService } from "../database/database.service";
import type { PayoutResponse } from "../flutterwave/flutterwave.interface";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";
import { PayoutStatusChangedHandler } from "../notification/handlers/payout-status-changed.handler";
import { NotificationOutboxService } from "../notification/notification-outbox.service";
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
const PAYOUT_RECONCILIATION_GRACE_PERIOD_MS = 15 * 60 * 1000;
const PAYOUT_RECONCILIATION_BATCH_SIZE = 50;
type TerminalPayoutStatus = "PAID_OUT" | "FAILED";

@Injectable()
export class PaymentService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly flutterwaveService: FlutterwaveService,
    private readonly notificationOutboxService: NotificationOutboxService,
    private readonly payoutStatusChangedHandler: PayoutStatusChangedHandler,
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
    reference: string,
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
        payoutProviderReference: reference,
        processingLeaseId,
        processingLeaseExpiresAt: new Date(now.getTime() + PAYOUT_PROCESSING_LEASE_MS),
      },
    });

    if (claimed.count === 0) {
      throw new PayoutProcessingInProgressException(bookingId);
    }

    return processingLeaseId;
  }

  private async handleSuccessfulPayout(
    bookingId: string,
    payoutTransaction: PayoutTransaction,
    processingLeaseId: string,
    status: PayoutTransactionStatus = PayoutTransactionStatus.PROCESSING,
  ): Promise<void> {
    if (status === PayoutTransactionStatus.PAID_OUT) {
      const finalized = await this.finalizePayoutStatus(
        payoutTransaction,
        PayoutTransactionStatus.PAID_OUT,
        { processingLeaseId },
      );
      if (!finalized) {
        throw new PayoutProcessingClaimLostException(bookingId);
      }
      return;
    }

    await this.databaseService.$transaction(async (tx) => {
      const updated = await tx.payoutTransaction.updateMany({
        where: {
          id: payoutTransaction.id,
          status: PayoutTransactionStatus.PROCESSING,
          processingLeaseId,
        },
        data: {
          status,
          processingLeaseId: null,
          processingLeaseExpiresAt: null,
          completedAt: null,
        },
      });
      if (updated.count === 0) {
        throw new PayoutProcessingClaimLostException(bookingId);
      }

      await tx.booking.update({
        where: { id: bookingId },
        data: { overallPayoutStatus: status },
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

  async finalizePayoutStatus(
    payoutTransaction: PayoutTransaction,
    status: TerminalPayoutStatus,
    options: {
      processingLeaseId?: string;
      failureReason?: string;
    } = {},
  ): Promise<boolean> {
    const bookingId = payoutTransaction.bookingId;

    return this.databaseService.$transaction(async (tx) => {
      const updated = await tx.payoutTransaction.updateMany({
        where: {
          id: payoutTransaction.id,
          status: PayoutTransactionStatus.PROCESSING,
          ...(options.processingLeaseId ? { processingLeaseId: options.processingLeaseId } : {}),
        },
        data: {
          status,
          completedAt: new Date(),
          processingLeaseId: null,
          processingLeaseExpiresAt: null,
          ...(status === PayoutTransactionStatus.FAILED
            ? {
                notes: `Flutterwave payout failed: ${options.failureReason ?? "Unknown failure"}`,
              }
            : {}),
        },
      });
      if (updated.count === 0) {
        return false;
      }
      if (!bookingId) {
        return true;
      }

      const booking = await tx.booking.update({
        where: { id: bookingId },
        data: { overallPayoutStatus: status },
        select: { bookingReference: true },
      });
      const finalizedPayout = await tx.payoutTransaction.findUniqueOrThrow({
        where: { id: payoutTransaction.id },
        include: {
          fleetOwner: {
            select: {
              id: true,
              name: true,
              email: true,
              phoneNumber: true,
            },
          },
        },
      });

      await this.notificationOutboxService.create(
        this.payoutStatusChangedHandler,
        {
          payoutTransactionId: finalizedPayout.id,
          bookingId,
          bookingReference: booking.bookingReference,
          status,
          amount: Number(finalizedPayout.amountToPay),
          failureReason: options.failureReason,
          fleetOwner: {
            userId: finalizedPayout.fleetOwner.id,
            name: finalizedPayout.fleetOwner.name,
            email: finalizedPayout.fleetOwner.email,
            phoneNumber: finalizedPayout.fleetOwner.phoneNumber,
          },
        },
        tx,
      );

      return true;
    });
  }

  private async releasePayoutProcessingLease(
    payoutTransactionId: string,
    processingLeaseId: string,
  ): Promise<void> {
    await this.databaseService.payoutTransaction.updateMany({
      where: {
        id: payoutTransactionId,
        status: PayoutTransactionStatus.PROCESSING,
        processingLeaseId,
      },
      data: {
        processingLeaseId: null,
        processingLeaseExpiresAt: null,
      },
    });
  }

  private async reconcileExistingPayout(
    bookingId: string,
    payoutTransaction: PayoutTransaction,
    reference: string,
    processingLeaseId: string,
  ): Promise<boolean> {
    const transfer = await this.flutterwaveService.findTransferByReference(reference);
    if (!transfer) {
      return false;
    }

    const status = transfer.status.trim().toUpperCase();
    if (status === "FAILED") {
      await this.handleFailedPayout(
        bookingId,
        payoutTransaction,
        transfer.complete_message || "Flutterwave transfer failed",
        processingLeaseId,
      );
      return true;
    }

    if (status === "SUCCESSFUL") {
      await this.handleSuccessfulPayout(
        bookingId,
        payoutTransaction,
        processingLeaseId,
        PayoutTransactionStatus.PAID_OUT,
      );
      return true;
    }

    await this.releasePayoutProcessingLease(payoutTransaction.id, processingLeaseId);
    this.logger.warn(
      {
        bookingId,
        transactionId: payoutTransaction.id,
        providerStatus: status,
      },
      "Payout remains pending at Flutterwave and will be reconciled later",
    );
    return true;
  }

  async reconcileProcessingPayouts(): Promise<number> {
    const now = new Date();
    const initiatedBefore = new Date(now.getTime() - PAYOUT_RECONCILIATION_GRACE_PERIOD_MS);
    const payouts = await this.databaseService.payoutTransaction.findMany({
      where: {
        status: PayoutTransactionStatus.PROCESSING,
        bookingId: { not: null },
        payoutProviderReference: { not: null },
        initiatedAt: { lte: initiatedBefore },
        OR: [
          { processingLeaseId: null },
          {
            processingLeaseExpiresAt: { lte: now },
          },
        ],
      },
      orderBy: { initiatedAt: "asc" },
      take: PAYOUT_RECONCILIATION_BATCH_SIZE,
    });

    let reconciledCount = 0;
    for (const payout of payouts) {
      try {
        if (await this.reconcileProcessingPayout(payout)) {
          reconciledCount += 1;
        }
      } catch (error) {
        this.logger.error(
          {
            bookingId: payout.bookingId,
            transactionId: payout.id,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to reconcile processing payout",
        );
      }
    }

    return reconciledCount;
  }

  private async reconcileProcessingPayout(payoutTransaction: PayoutTransaction): Promise<boolean> {
    const reference = payoutTransaction.payoutProviderReference;
    const bookingId = payoutTransaction.bookingId;
    if (!reference || !bookingId) {
      return false;
    }

    const now = new Date();
    const processingLeaseId = randomUUID();
    const claimed = await this.databaseService.payoutTransaction.updateMany({
      where: {
        id: payoutTransaction.id,
        status: PayoutTransactionStatus.PROCESSING,
        OR: [
          { processingLeaseId: null },
          {
            processingLeaseExpiresAt: { lte: now },
          },
        ],
      },
      data: {
        processingLeaseId,
        processingLeaseExpiresAt: new Date(now.getTime() + PAYOUT_PROCESSING_LEASE_MS),
      },
    });
    if (claimed.count === 0) {
      return false;
    }

    const transfer = await this.flutterwaveService.findTransferByReference(reference);
    const status = transfer?.status.trim().toUpperCase();

    if (status === "SUCCESSFUL") {
      await this.handleSuccessfulPayout(
        bookingId,
        payoutTransaction,
        processingLeaseId,
        PayoutTransactionStatus.PAID_OUT,
      );
      return true;
    }

    if (status === "FAILED") {
      await this.handleFailedPayout(
        bookingId,
        payoutTransaction,
        transfer.complete_message || "Flutterwave transfer failed",
        processingLeaseId,
      );
      return true;
    }

    await this.releasePayoutProcessingLease(payoutTransaction.id, processingLeaseId);
    this.logger.warn(
      {
        bookingId: payoutTransaction.bookingId,
        transactionId: payoutTransaction.id,
        providerStatus: status ?? "NOT_FOUND",
      },
      "Payout remains unresolved after the reconciliation grace period",
    );
    return false;
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
    const finalized = await this.finalizePayoutStatus(
      payoutTransaction,
      PayoutTransactionStatus.FAILED,
      {
        processingLeaseId,
        failureReason: errorMessage,
      },
    );
    if (!finalized) {
      return;
    }

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

      const reference = `payout_${payoutTransaction.id}`;
      const processingLeaseId = await this.claimPayoutProcessing(
        booking.id,
        payoutTransaction,
        reference,
      );
      if (!processingLeaseId) {
        return;
      }

      if (
        payoutTransaction.status === PayoutTransactionStatus.PROCESSING &&
        (await this.reconcileExistingPayout(
          booking.id,
          payoutTransaction,
          reference,
          processingLeaseId,
        ))
      ) {
        return;
      }

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
        throw new PayoutInitiationFailedException(booking.id, reason);
      }

      if (payoutResult.success) {
        await this.handleSuccessfulPayout(booking.id, payoutTransaction, processingLeaseId);
      } else {
        const reason = this.extractErrorMessage(payoutResult.data);
        await this.handleFailedPayout(booking.id, payoutTransaction, reason, processingLeaseId);
        throw new PayoutInitiationFailedException(booking.id, reason);
      }
    } catch (error) {
      if (error instanceof PayoutProcessingInProgressException) {
        this.logger.warn({ bookingId: booking.id }, error.message);
      } else if (error instanceof Error) {
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
