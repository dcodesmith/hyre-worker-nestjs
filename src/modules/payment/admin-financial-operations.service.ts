import { Injectable } from "@nestjs/common";
import {
  FinancialReconciliationOutcome,
  FinancialReconciliationResourceType,
  type Payment,
  PaymentAttemptStatus,
  PayoutTransactionStatus,
  type Prisma,
} from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { AppException } from "../../common/errors/app.exception";
import { DatabaseService } from "../database/database.service";
import type {
  AdminPayoutListQueryDto,
  AdminRefundListQueryDto,
  ReconcileRefundBodyDto,
} from "./dto/admin-financial-operations.dto";
import {
  FinancialOperationNotFoundException,
  FinancialProviderIdentityMissingException,
  FinancialProviderReferenceMismatchException,
  FinancialProviderReferenceMissingException,
  FinancialReconciliationNotAllowedException,
} from "./payment.error";
import {
  PAYOUT_RECONCILIATION_GRACE_PERIOD_MS,
  PaymentService,
  type PayoutReconciliationResult,
} from "./payment.service";
import { RefundReconciliationService } from "./refund-reconciliation.service";

const refundAdminInclude = {
  booking: {
    select: {
      id: true,
      bookingReference: true,
    },
  },
  extension: {
    select: {
      id: true,
      paymentStatus: true,
      bookingLeg: {
        select: {
          booking: {
            select: {
              id: true,
              bookingReference: true,
            },
          },
        },
      },
    },
  },
} satisfies Prisma.PaymentInclude;

const payoutAdminInclude = {
  booking: {
    select: {
      id: true,
      bookingReference: true,
      overallPayoutStatus: true,
    },
  },
  fleetOwner: {
    select: {
      id: true,
      name: true,
      email: true,
    },
  },
} satisfies Prisma.PayoutTransactionInclude;

type RefundAdminRecord = Prisma.PaymentGetPayload<{ include: typeof refundAdminInclude }>;
type PayoutAdminRecord = Prisma.PayoutTransactionGetPayload<{ include: typeof payoutAdminInclude }>;

const REFUND_STATUSES: PaymentAttemptStatus[] = [
  PaymentAttemptStatus.REFUND_PROCESSING,
  PaymentAttemptStatus.REFUND_ERROR,
  PaymentAttemptStatus.REFUNDED,
  PaymentAttemptStatus.PARTIALLY_REFUNDED,
  PaymentAttemptStatus.REFUND_FAILED,
];

const REFUND_RECONCILABLE_STATUSES = new Set<PaymentAttemptStatus>([
  PaymentAttemptStatus.REFUND_PROCESSING,
  PaymentAttemptStatus.REFUND_ERROR,
]);

@Injectable()
export class AdminFinancialOperationsService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly paymentService: PaymentService,
    private readonly refundReconciliationService: RefundReconciliationService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AdminFinancialOperationsService.name);
  }

  async listRefunds(query: AdminRefundListQueryDto) {
    const where: Prisma.PaymentWhereInput = query.attentionOnly
      ? {
          refundManualReviewNotifiedAt: { not: null },
          status: {
            in: [
              PaymentAttemptStatus.SUCCESSFUL,
              PaymentAttemptStatus.REFUND_PROCESSING,
              PaymentAttemptStatus.REFUND_ERROR,
            ],
          },
          ...(query.status ? { AND: [{ status: query.status }] } : {}),
        }
      : {
          status: query.status ? query.status : { in: REFUND_STATUSES },
        };
    const skip = (query.page - 1) * query.limit;
    const [refunds, total] = await Promise.all([
      this.databaseService.payment.findMany({
        where,
        include: refundAdminInclude,
        orderBy: { refundRequestedAt: "asc" },
        skip,
        take: query.limit,
      }),
      this.databaseService.payment.count({ where }),
    ]);

    return {
      refunds: refunds.map((refund) => this.mapRefund(refund)),
      meta: this.getPaginationMeta(query.page, query.limit, total),
    };
  }

  async getRefund(paymentId: string) {
    const payment = await this.findRefund(paymentId);
    const audits = await this.getAudits(FinancialReconciliationResourceType.REFUND, paymentId);
    return { ...this.mapRefund(payment), audits };
  }

  async reconcileRefund(paymentId: string, body: ReconcileRefundBodyDto, actorUserId: string) {
    const payment = await this.findRefund(paymentId);
    if (!REFUND_RECONCILABLE_STATUSES.has(payment.status)) {
      throw new FinancialReconciliationNotAllowedException("refund", payment.id, payment.status);
    }
    if (!payment.flutterwaveTransactionId) {
      throw new FinancialProviderIdentityMissingException("refund", payment.id);
    }
    if (
      payment.refundProviderId &&
      body.refundProviderId &&
      payment.refundProviderId !== body.refundProviderId
    ) {
      throw new FinancialProviderReferenceMismatchException("refund", payment.id);
    }
    const providerReference = payment.refundProviderId ?? body.refundProviderId;
    if (!providerReference) {
      throw new FinancialProviderReferenceMissingException("refund", payment.id);
    }

    const auditId = await this.startAudit(
      FinancialReconciliationResourceType.REFUND,
      payment.id,
      actorUserId,
      providerReference,
    );
    let handled: boolean;
    try {
      handled = await this.refundReconciliationService.reconcileWebhookRefund(
        payment.id,
        providerReference,
      );
    } catch (error) {
      await this.recordFailedAudit(auditId, error);
      throw error;
    }
    const current = await this.findRefund(payment.id);
    const reconciled = handled && this.isTerminalRefundStatus(current.status);
    await this.recordCompletedAudit(
      auditId,
      reconciled
        ? FinancialReconciliationOutcome.RECONCILED
        : FinancialReconciliationOutcome.UNRESOLVED,
      current.refundProviderStatus,
    );
    this.logger.info(
      { actorUserId, paymentId, reconciled },
      "Admin reconciled refund against Flutterwave",
    );
    return {
      reconciled,
      status: current.status,
      providerStatus: current.refundProviderStatus,
      refund: this.mapRefund(current),
    };
  }

  async listPayouts(query: AdminPayoutListQueryDto) {
    const initiatedBefore = new Date(Date.now() - PAYOUT_RECONCILIATION_GRACE_PERIOD_MS);
    const attentionFilter: Prisma.PayoutTransactionWhereInput = {
      OR: [
        { status: PayoutTransactionStatus.FAILED },
        {
          status: PayoutTransactionStatus.PROCESSING,
          initiatedAt: { lte: initiatedBefore },
        },
      ],
    };
    const where: Prisma.PayoutTransactionWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.attentionOnly ? attentionFilter : {}),
    };
    const skip = (query.page - 1) * query.limit;
    const [payouts, total] = await Promise.all([
      this.databaseService.payoutTransaction.findMany({
        where,
        include: payoutAdminInclude,
        orderBy: { initiatedAt: "asc" },
        skip,
        take: query.limit,
      }),
      this.databaseService.payoutTransaction.count({ where }),
    ]);

    return {
      payouts: payouts.map((payout) => this.mapPayout(payout)),
      meta: this.getPaginationMeta(query.page, query.limit, total),
    };
  }

  async getPayout(payoutTransactionId: string) {
    const payout = await this.findPayout(payoutTransactionId);
    const audits = await this.getAudits(
      FinancialReconciliationResourceType.PAYOUT,
      payoutTransactionId,
    );
    return { ...this.mapPayout(payout), audits };
  }

  async reconcilePayout(payoutTransactionId: string, actorUserId: string) {
    const payout = await this.findPayout(payoutTransactionId);
    if (payout.status !== PayoutTransactionStatus.PROCESSING) {
      throw new FinancialReconciliationNotAllowedException("payout", payout.id, payout.status);
    }
    if (!payout.payoutProviderReference) {
      throw new FinancialProviderReferenceMissingException("payout", payout.id);
    }

    const auditId = await this.startAudit(
      FinancialReconciliationResourceType.PAYOUT,
      payout.id,
      actorUserId,
      payout.payoutProviderReference,
    );
    let result: PayoutReconciliationResult;
    try {
      result = await this.paymentService.reconcilePayout(payout);
    } catch (error) {
      await this.recordFailedAudit(auditId, error);
      throw error;
    }
    const current = await this.findPayout(payout.id);
    const reconciled = result.reconciled;
    await this.recordCompletedAudit(
      auditId,
      reconciled
        ? FinancialReconciliationOutcome.RECONCILED
        : FinancialReconciliationOutcome.UNRESOLVED,
      result.providerStatus,
      result.mismatchReason,
    );
    this.logger.info(
      { actorUserId, payoutTransactionId, reconciled },
      "Admin reconciled payout against Flutterwave",
    );
    return {
      reconciled,
      status: current.status,
      providerStatus: result.providerStatus,
      mismatchReason: result.mismatchReason,
      payout: this.mapPayout(current),
    };
  }

  private async findRefund(paymentId: string): Promise<RefundAdminRecord> {
    const payment = await this.databaseService.payment.findUnique({
      where: { id: paymentId },
      include: refundAdminInclude,
    });
    if (!payment || !this.isRefundRecord(payment)) {
      throw new FinancialOperationNotFoundException("refund", paymentId);
    }
    return payment;
  }

  private async findPayout(payoutTransactionId: string): Promise<PayoutAdminRecord> {
    const payout = await this.databaseService.payoutTransaction.findUnique({
      where: { id: payoutTransactionId },
      include: payoutAdminInclude,
    });
    if (!payout) {
      throw new FinancialOperationNotFoundException("payout", payoutTransactionId);
    }
    return payout;
  }

  private isRefundRecord(payment: Payment): boolean {
    return (
      payment.refundRequestedAt !== null ||
      payment.refundProviderId !== null ||
      payment.refundManualReviewNotifiedAt !== null ||
      REFUND_STATUSES.includes(payment.status)
    );
  }

  private isTerminalRefundStatus(status: PaymentAttemptStatus): boolean {
    return (
      status === PaymentAttemptStatus.REFUNDED ||
      status === PaymentAttemptStatus.PARTIALLY_REFUNDED ||
      status === PaymentAttemptStatus.REFUND_FAILED
    );
  }

  private mapRefund(payment: RefundAdminRecord) {
    const booking = payment.booking ?? payment.extension?.bookingLeg.booking;
    return {
      id: payment.id,
      txRef: payment.txRef,
      status: payment.status,
      amountCharged: payment.amountCharged?.toNumber() ?? null,
      refundRequestedAmount: payment.refundRequestedAmount?.toNumber() ?? null,
      currency: payment.currency,
      refundProviderId: payment.refundProviderId,
      refundProviderStatus: payment.refundProviderStatus,
      refundRequestedAt: payment.refundRequestedAt,
      refundLastCheckedAt: payment.refundLastCheckedAt,
      refundReconciliationAttempts: payment.refundReconciliationAttempts,
      refundVerificationFailures: payment.refundVerificationFailures,
      refundManualReviewNotifiedAt: payment.refundManualReviewNotifiedAt,
      canReconcile:
        REFUND_RECONCILABLE_STATUSES.has(payment.status) &&
        payment.flutterwaveTransactionId !== null,
      booking: booking
        ? {
            id: booking.id,
            bookingReference: booking.bookingReference,
          }
        : null,
      extension: payment.extension
        ? {
            id: payment.extension.id,
            paymentStatus: payment.extension.paymentStatus,
          }
        : null,
    };
  }

  private mapPayout(payout: PayoutAdminRecord) {
    return {
      id: payout.id,
      status: payout.status,
      fleetOwner: payout.fleetOwner,
      booking: payout.booking,
      extensionId: payout.extensionId,
      amountToPay: payout.amountToPay.toNumber(),
      amountPaid: payout.amountPaid?.toNumber() ?? null,
      currency: payout.currency,
      payoutProviderReference: payout.payoutProviderReference,
      payoutMethodDetails: payout.payoutMethodDetails,
      initiatedAt: payout.initiatedAt,
      processedAt: payout.processedAt,
      completedAt: payout.completedAt,
      notes: payout.notes,
    };
  }

  private getPaginationMeta(page: number, limit: number, total: number) {
    return {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    };
  }

  private async startAudit(
    resourceType: FinancialReconciliationResourceType,
    resourceId: string,
    actorUserId: string,
    providerReference: string,
  ): Promise<string> {
    const audit = await this.databaseService.financialReconciliationAudit.create({
      data: {
        resourceType,
        resourceId,
        actorUserId,
        providerReference,
      },
      select: { id: true },
    });
    return audit.id;
  }

  private async recordCompletedAudit(
    auditId: string,
    outcome: FinancialReconciliationOutcome,
    providerStatus: string | null,
    reason?: string | null,
  ): Promise<void> {
    try {
      await this.databaseService.financialReconciliationAudit.update({
        where: { id: auditId },
        data: {
          outcome,
          providerStatus,
          ...(reason ? { error: reason } : {}),
        },
      });
    } catch (error) {
      this.logger.error(
        {
          auditId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to complete financial reconciliation audit",
      );
    }
  }

  private async recordFailedAudit(auditId: string, error: unknown): Promise<void> {
    this.logger.error(
      {
        auditId,
        error: error instanceof Error ? error.message : String(error),
      },
      "Financial reconciliation attempt failed",
    );
    try {
      await this.databaseService.financialReconciliationAudit.update({
        where: { id: auditId },
        data: {
          outcome: FinancialReconciliationOutcome.FAILED,
          error: this.getAuditError(error),
        },
      });
    } catch (auditError) {
      this.logger.error(
        {
          auditId,
          error: auditError instanceof Error ? auditError.message : String(auditError),
        },
        "Failed to persist financial reconciliation audit failure",
      );
    }
  }

  private getAuditError(error: unknown): string {
    return error instanceof AppException ? error.getErrorCode() : "FINANCIAL_RECONCILIATION_FAILED";
  }

  private getAudits(resourceType: FinancialReconciliationResourceType, resourceId: string) {
    return this.databaseService.financialReconciliationAudit.findMany({
      where: { resourceType, resourceId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        actorUserId: true,
        outcome: true,
        providerReference: true,
        providerStatus: true,
        error: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }
}
