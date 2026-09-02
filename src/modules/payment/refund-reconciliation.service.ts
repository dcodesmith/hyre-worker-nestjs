import { Injectable } from "@nestjs/common";
import { type Payment, PaymentAttemptStatus } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { toLogError } from "../../common/logging/error-logging.helper";
import { DatabaseService } from "../database/database.service";
import type { FlutterwaveFetchedRefundData } from "../flutterwave/flutterwave.interface";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";
import { RefundFinalizationService } from "./refund-finalization.service";
import { classifyRefundProviderStatus, type RefundProviderState } from "./refund-status";

const RECONCILIATION_GRACE_PERIOD_MS = 15 * 60 * 1000;
const RECONCILIATION_BATCH_SIZE = 50;
const FETCH_FAILURE_HANDOFF_ATTEMPTS = 3;
const BANK_REFUND_SLA_MS = 48 * 60 * 60 * 1000;
const MOBILE_MONEY_REFUND_SLA_MS = 6 * 24 * 60 * 60 * 1000;
const CARD_OR_UNKNOWN_REFUND_SLA_MS = 16 * 24 * 60 * 60 * 1000;

@Injectable()
export class RefundReconciliationService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly flutterwaveService: FlutterwaveService,
    private readonly refundFinalizationService: RefundFinalizationService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RefundReconciliationService.name);
  }

  async reconcileProcessingRefunds(): Promise<number> {
    const requestedBefore = new Date(Date.now() - RECONCILIATION_GRACE_PERIOD_MS);
    const payments = await this.databaseService.payment.findMany({
      where: {
        status: {
          in: [PaymentAttemptStatus.REFUND_PROCESSING, PaymentAttemptStatus.REFUND_ERROR],
        },
        refundRequestedAt: { lte: requestedBefore },
        refundManualReviewNotifiedAt: null,
      },
      orderBy: { refundRequestedAt: "asc" },
      take: RECONCILIATION_BATCH_SIZE,
    });

    let reconciledCount = 0;
    for (const payment of payments) {
      try {
        if (await this.reconcilePayment(payment)) {
          reconciledCount += 1;
        }
      } catch (error) {
        this.logger.error(
          {
            paymentId: payment.id,
            err: toLogError(error),
          },
          "Failed to reconcile refund",
        );
      }
    }

    return reconciledCount;
  }

  async reconcileWebhookRefund(paymentId: string, refundProviderId: string): Promise<boolean> {
    const payment = await this.databaseService.payment.findUnique({
      where: { id: paymentId },
    });
    if (!payment) {
      return false;
    }

    if (
      payment.status === PaymentAttemptStatus.REFUNDED ||
      payment.status === PaymentAttemptStatus.PARTIALLY_REFUNDED ||
      payment.status === PaymentAttemptStatus.REFUND_FAILED
    ) {
      return false;
    }

    if (
      payment.status !== PaymentAttemptStatus.REFUND_PROCESSING &&
      payment.status !== PaymentAttemptStatus.REFUND_ERROR
    ) {
      return this.refundFinalizationService.requestManualReview({
        paymentId,
        reason: `Flutterwave reported refund ${refundProviderId} while local payment status is ${payment.status}`,
      });
    }

    if (payment.refundProviderId && payment.refundProviderId !== refundProviderId) {
      return this.refundFinalizationService.requestManualReview({
        paymentId,
        reason: `Webhook refund ID ${refundProviderId} does not match persisted refund ID ${payment.refundProviderId}`,
      });
    }

    const paymentToReconcile = await this.bindRefundProviderId(payment, refundProviderId);
    if (paymentToReconcile === null) {
      return false;
    }
    if (typeof paymentToReconcile === "boolean") {
      return paymentToReconcile;
    }

    return this.reconcilePayment(paymentToReconcile);
  }

  private async bindRefundProviderId(
    payment: Payment,
    refundProviderId: string,
  ): Promise<Payment | boolean | null> {
    if (payment.refundProviderId) {
      return payment;
    }

    const result = await this.databaseService.payment.updateMany({
      where: {
        id: payment.id,
        refundProviderId: null,
        status: {
          in: [PaymentAttemptStatus.REFUND_PROCESSING, PaymentAttemptStatus.REFUND_ERROR],
        },
      },
      data: { refundProviderId },
    });
    if (result.count !== 0) {
      return { ...payment, refundProviderId };
    }

    const currentPayment = await this.databaseService.payment.findUnique({
      where: { id: payment.id },
    });
    if (
      !currentPayment ||
      (currentPayment.status !== PaymentAttemptStatus.REFUND_PROCESSING &&
        currentPayment.status !== PaymentAttemptStatus.REFUND_ERROR)
    ) {
      return null;
    }
    if (currentPayment.refundProviderId !== refundProviderId) {
      return this.refundFinalizationService.requestManualReview({
        paymentId: payment.id,
        reason: `Webhook refund ID ${refundProviderId} does not match persisted refund ID ${currentPayment.refundProviderId ?? "missing"}`,
      });
    }
    return currentPayment;
  }

  private async reconcilePayment(payment: Payment): Promise<boolean> {
    if (!payment.refundProviderId) {
      return this.refundFinalizationService.requestManualReview({
        paymentId: payment.id,
        reason:
          "Flutterwave refund ID is unavailable after an uncertain initiation; verify the transaction before retrying",
      });
    }

    let providerRefund: FlutterwaveFetchedRefundData;
    try {
      providerRefund = await this.flutterwaveService.fetchRefund(payment.refundProviderId);
    } catch (error) {
      await this.handleFetchFailure(payment, error);
      return false;
    }
    const providerState = classifyRefundProviderStatus(providerRefund.status);
    const mismatchReason = this.getMismatchReason(payment, providerRefund, providerState);
    if (mismatchReason) {
      return this.refundFinalizationService.requestManualReview({
        paymentId: payment.id,
        reason: mismatchReason,
      });
    }

    await this.recordProviderCheck(payment.id, providerRefund.status, providerState === "UNKNOWN");
    if (providerState === "SUCCEEDED") {
      const amountCharged = payment.amountCharged?.toNumber();
      const isFullRefund = amountCharged != null && providerRefund.amount_refunded >= amountCharged;
      return this.refundFinalizationService.finalize({
        paymentId: payment.id,
        refundId: payment.refundProviderId,
        status: isFullRefund
          ? PaymentAttemptStatus.REFUNDED
          : PaymentAttemptStatus.PARTIALLY_REFUNDED,
        amount: providerRefund.amount_refunded,
        providerMetadata: {
          status: providerRefund.status,
          flutterwaveReference: providerRefund.flw_ref,
        },
      });
    }

    if (providerState === "FAILED") {
      return this.refundFinalizationService.finalize({
        paymentId: payment.id,
        refundId: payment.refundProviderId,
        status: PaymentAttemptStatus.REFUND_FAILED,
        amount: payment.refundRequestedAmount?.toNumber() ?? providerRefund.amount_refunded,
        failureReason: providerRefund.comment || providerRefund.status,
        providerMetadata: {
          status: providerRefund.status,
          flutterwaveReference: providerRefund.flw_ref,
        },
      });
    }

    const verificationFailures = payment.refundVerificationFailures + 1;
    if (providerState === "UNKNOWN" && verificationFailures >= FETCH_FAILURE_HANDOFF_ATTEMPTS) {
      return this.refundFinalizationService.requestManualReview({
        paymentId: payment.id,
        reason: `Flutterwave returned unrecognized refund status "${providerRefund.status}"`,
      });
    }

    if (this.isPastProviderSla(payment)) {
      return this.refundFinalizationService.requestManualReview({
        paymentId: payment.id,
        reason: `Refund remains ${providerRefund.status} beyond the expected provider completion window`,
      });
    }

    return false;
  }

  private getMismatchReason(
    payment: Payment,
    providerRefund: FlutterwaveFetchedRefundData,
    providerState: RefundProviderState,
  ): string | null {
    if (String(providerRefund.id) !== payment.refundProviderId) {
      return `Refund provider ID mismatch: expected ${payment.refundProviderId}, received ${providerRefund.id}`;
    }

    if (
      payment.flutterwaveTransactionId &&
      String(providerRefund.transaction_id) !== payment.flutterwaveTransactionId
    ) {
      return "Flutterwave refund belongs to a different transaction";
    }

    if (
      providerRefund.amount_refunded < 0 ||
      (providerState !== "FAILED" && providerRefund.amount_refunded === 0) ||
      (payment.amountCharged && providerRefund.amount_refunded > payment.amountCharged.toNumber())
    ) {
      return "Flutterwave refund amount does not match the refundable payment amount";
    }

    return null;
  }

  private async recordProviderCheck(
    paymentId: string,
    providerStatus: string,
    verificationFailed = false,
  ): Promise<void> {
    await this.databaseService.payment.updateMany({
      where: {
        id: paymentId,
        status: {
          in: [PaymentAttemptStatus.REFUND_PROCESSING, PaymentAttemptStatus.REFUND_ERROR],
        },
      },
      data: {
        refundProviderStatus: providerStatus,
        refundLastCheckedAt: new Date(),
        refundReconciliationAttempts: { increment: 1 },
        refundVerificationFailures: verificationFailed ? { increment: 1 } : 0,
      },
    });
  }

  private async handleFetchFailure(payment: Payment, error: unknown): Promise<void> {
    const attempts = payment.refundVerificationFailures + 1;
    await this.recordProviderCheck(payment.id, payment.refundProviderStatus ?? "fetch-error", true);
    this.logger.error(
      {
        paymentId: payment.id,
        refundProviderId: payment.refundProviderId,
        attempts,
        err: toLogError(error),
      },
      "Failed to fetch refund status from Flutterwave",
    );

    if (attempts >= FETCH_FAILURE_HANDOFF_ATTEMPTS) {
      await this.refundFinalizationService.requestManualReview({
        paymentId: payment.id,
        reason: `Flutterwave refund verification failed ${attempts} consecutive times`,
      });
    }
  }

  private isPastProviderSla(payment: Payment): boolean {
    if (!payment.refundRequestedAt) {
      return true;
    }

    const paymentMethod = payment.paymentMethod?.trim().toLowerCase() ?? "";
    let slaMs = CARD_OR_UNKNOWN_REFUND_SLA_MS;
    if (paymentMethod.includes("momo") || paymentMethod.includes("mobile")) {
      slaMs = MOBILE_MONEY_REFUND_SLA_MS;
    } else if (paymentMethod.includes("bank") || paymentMethod.includes("account")) {
      slaMs = BANK_REFUND_SLA_MS;
    }

    return payment.refundRequestedAt.getTime() <= Date.now() - slaMs;
  }
}
