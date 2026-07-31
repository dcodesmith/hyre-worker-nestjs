import { Test, type TestingModule } from "@nestjs/testing";
import {
  FinancialReconciliationOutcome,
  PaymentAttemptStatus,
  PayoutTransactionStatus,
} from "@prisma/client";
import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { createPaymentRecord, createPayoutTransaction } from "../../shared/helper.fixtures";
import { DatabaseService } from "../database/database.service";
import {
  AdminFinancialOperationsService,
  type PayoutAdminRecord,
  type RefundAdminRecord,
} from "./admin-financial-operations.service";
import {
  FinancialProviderIdentityMissingException,
  FinancialProviderReferenceMismatchException,
  FinancialProviderReferenceMissingException,
  FinancialReconciliationNotAllowedException,
} from "./payment.error";
import { PaymentService } from "./payment.service";
import { RefundReconciliationService } from "./refund-reconciliation.service";

const createRefund = (overrides: Partial<RefundAdminRecord> = {}): RefundAdminRecord => ({
  ...createPaymentRecord({
    id: "payment-1",
    bookingId: "booking-1",
    txRef: "tx-ref-1",
    flutterwaveTransactionId: "123",
    amountCharged: new Decimal(1000),
    status: PaymentAttemptStatus.REFUND_ERROR,
    refundIdempotencyKey: "refund-key-1",
    refundProviderId: "refund-1",
    refundProviderStatus: "processing",
    refundRequestedAmount: new Decimal(1000),
    refundRequestedAt: new Date("2026-07-30T10:02:00.000Z"),
    refundManualReviewNotifiedAt: new Date("2026-07-30T11:00:00.000Z"),
  }),
  booking: {
    id: "booking-1",
    bookingReference: "HYR-1",
  },
  extension: null,
  ...overrides,
});

const createPayout = (overrides: Partial<PayoutAdminRecord> = {}): PayoutAdminRecord => ({
  ...createPayoutTransaction({
    id: "payout-1",
    fleetOwnerId: "owner-1",
    bookingId: "booking-1",
    amountToPay: new Decimal(800),
    status: PayoutTransactionStatus.PROCESSING,
    payoutProviderReference: "payout_payout-1",
  }),
  payoutMethodDetails: "Bank: Test, Account: ****1234",
  initiatedAt: new Date("2026-07-30T10:00:00.000Z"),
  booking: {
    id: "booking-1",
    bookingReference: "HYR-1",
    overallPayoutStatus: PayoutTransactionStatus.PROCESSING,
  },
  fleetOwner: {
    id: "owner-1",
    name: "Fleet Owner",
    email: "owner@example.com",
  },
  ...overrides,
});

describe("AdminFinancialOperationsService", () => {
  let service: AdminFinancialOperationsService;

  const databaseServiceMock = {
    payment: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
    },
    payoutTransaction: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
    },
    financialReconciliationAudit: {
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
    },
  };
  const paymentServiceMock = {
    reconcilePayout: vi.fn(),
  };
  const refundReconciliationServiceMock = {
    reconcileWebhookRefund: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    databaseServiceMock.payment.findMany.mockResolvedValue([]);
    databaseServiceMock.payment.count.mockResolvedValue(0);
    databaseServiceMock.payoutTransaction.findMany.mockResolvedValue([]);
    databaseServiceMock.payoutTransaction.count.mockResolvedValue(0);
    databaseServiceMock.financialReconciliationAudit.create.mockResolvedValue({
      id: "audit-1",
    });
    databaseServiceMock.financialReconciliationAudit.update.mockResolvedValue({});
    databaseServiceMock.financialReconciliationAudit.findMany.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminFinancialOperationsService,
        { provide: DatabaseService, useValue: databaseServiceMock },
        { provide: PaymentService, useValue: paymentServiceMock },
        {
          provide: RefundReconciliationService,
          useValue: refundReconciliationServiceMock,
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get(AdminFinancialOperationsService);
  });

  it("lists only unresolved manual-review refunds by default", async () => {
    databaseServiceMock.payment.findMany.mockResolvedValueOnce([createRefund()]);
    databaseServiceMock.payment.count.mockResolvedValueOnce(1);

    const result = await service.listRefunds({
      page: 1,
      limit: 20,
      attentionOnly: true,
    });

    expect(databaseServiceMock.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          refundManualReviewNotifiedAt: { not: null },
          status: {
            in: [
              PaymentAttemptStatus.SUCCESSFUL,
              PaymentAttemptStatus.REFUND_PROCESSING,
              PaymentAttemptStatus.REFUND_ERROR,
            ],
          },
        },
      }),
    );
    expect(result).toMatchObject({
      refunds: [{ id: "payment-1", refundProviderId: "refund-1" }],
      meta: { page: 1, limit: 20, total: 1, totalPages: 1 },
    });
  });

  it("reconciles a refund and records the admin audit", async () => {
    const initial = createRefund();
    const finalized = createRefund({
      status: PaymentAttemptStatus.REFUNDED,
      refundProviderStatus: "completed",
    });
    databaseServiceMock.payment.findUnique
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(finalized);
    refundReconciliationServiceMock.reconcileWebhookRefund.mockResolvedValueOnce(true);

    const result = await service.reconcileRefund("payment-1", {}, "admin-1");

    expect(refundReconciliationServiceMock.reconcileWebhookRefund).toHaveBeenCalledWith(
      "payment-1",
      "refund-1",
    );
    expect(databaseServiceMock.financialReconciliationAudit.create).toHaveBeenCalledWith({
      data: {
        resourceType: "REFUND",
        resourceId: "payment-1",
        actorUserId: "admin-1",
        providerReference: "refund-1",
      },
      select: { id: true },
    });
    expect(databaseServiceMock.financialReconciliationAudit.update).toHaveBeenCalledWith({
      where: { id: "audit-1" },
      data: {
        outcome: FinancialReconciliationOutcome.RECONCILED,
        providerStatus: "completed",
      },
    });
    expect(result).toMatchObject({
      reconciled: true,
      status: PaymentAttemptStatus.REFUNDED,
    });
  });

  it("accepts an operator-supplied refund ID only when the local ID is missing", async () => {
    const refund = createRefund({ refundProviderId: null });
    databaseServiceMock.payment.findUnique
      .mockResolvedValueOnce(refund)
      .mockResolvedValueOnce(refund);
    refundReconciliationServiceMock.reconcileWebhookRefund.mockResolvedValueOnce(false);

    await service.reconcileRefund("payment-1", { refundProviderId: "refund-recovered" }, "admin-1");

    expect(refundReconciliationServiceMock.reconcileWebhookRefund).toHaveBeenCalledWith(
      "payment-1",
      "refund-recovered",
    );
  });

  it("rejects an operator-supplied refund ID that conflicts with the stored ID", async () => {
    databaseServiceMock.payment.findUnique.mockResolvedValueOnce(createRefund());

    await expect(
      service.reconcileRefund("payment-1", { refundProviderId: "refund-other" }, "admin-1"),
    ).rejects.toThrow(FinancialProviderReferenceMismatchException);
    expect(refundReconciliationServiceMock.reconcileWebhookRefund).not.toHaveBeenCalled();
    expect(databaseServiceMock.financialReconciliationAudit.create).not.toHaveBeenCalled();
  });

  it("rejects refund reconciliation without a provider ID", async () => {
    databaseServiceMock.payment.findUnique.mockResolvedValueOnce(
      createRefund({ refundProviderId: null }),
    );

    await expect(service.reconcileRefund("payment-1", {}, "admin-1")).rejects.toThrow(
      FinancialProviderReferenceMissingException,
    );
    expect(databaseServiceMock.financialReconciliationAudit.create).not.toHaveBeenCalled();
  });

  it("rejects refund reconciliation without the original provider transaction ID", async () => {
    databaseServiceMock.payment.findUnique.mockResolvedValueOnce(
      createRefund({ flutterwaveTransactionId: null }),
    );

    await expect(service.reconcileRefund("payment-1", {}, "admin-1")).rejects.toThrow(
      FinancialProviderIdentityMissingException,
    );
    expect(databaseServiceMock.financialReconciliationAudit.create).not.toHaveBeenCalled();
  });

  it("rejects refund reconciliation after a terminal state", async () => {
    databaseServiceMock.payment.findUnique.mockResolvedValueOnce(
      createRefund({ status: PaymentAttemptStatus.REFUNDED }),
    );

    await expect(service.reconcileRefund("payment-1", {}, "admin-1")).rejects.toThrow(
      FinancialReconciliationNotAllowedException,
    );
  });

  it("records an unresolved payout provider result", async () => {
    const payout = createPayout();
    databaseServiceMock.payoutTransaction.findUnique
      .mockResolvedValueOnce(payout)
      .mockResolvedValueOnce(payout);
    paymentServiceMock.reconcilePayout.mockResolvedValueOnce({
      reconciled: false,
      providerStatus: "PENDING",
    });

    const result = await service.reconcilePayout("payout-1", "admin-1");

    expect(databaseServiceMock.financialReconciliationAudit.update).toHaveBeenCalledWith({
      where: { id: "audit-1" },
      data: {
        outcome: FinancialReconciliationOutcome.UNRESOLVED,
        providerStatus: "PENDING",
      },
    });
    expect(result).toMatchObject({
      reconciled: false,
      status: PayoutTransactionStatus.PROCESSING,
      providerStatus: "PENDING",
    });
  });

  it("does not attribute another worker's payout finalization to the admin attempt", async () => {
    databaseServiceMock.payoutTransaction.findUnique
      .mockResolvedValueOnce(createPayout())
      .mockResolvedValueOnce(
        createPayout({
          status: PayoutTransactionStatus.PAID_OUT,
          amountPaid: new Decimal(800),
        }),
      );
    paymentServiceMock.reconcilePayout.mockResolvedValueOnce({
      reconciled: false,
      providerStatus: null,
      mismatchReason: null,
    });

    const result = await service.reconcilePayout("payout-1", "admin-1");

    expect(result).toMatchObject({
      reconciled: false,
      status: PayoutTransactionStatus.PAID_OUT,
    });
    expect(databaseServiceMock.financialReconciliationAudit.update).toHaveBeenCalledWith({
      where: { id: "audit-1" },
      data: {
        outcome: FinancialReconciliationOutcome.UNRESOLVED,
        providerStatus: null,
      },
    });
  });

  it("returns the verified result when audit completion temporarily fails", async () => {
    const payout = createPayout();
    databaseServiceMock.payoutTransaction.findUnique
      .mockResolvedValueOnce(payout)
      .mockResolvedValueOnce(payout);
    paymentServiceMock.reconcilePayout.mockResolvedValueOnce({
      reconciled: false,
      providerStatus: "PENDING",
      mismatchReason: null,
    });
    databaseServiceMock.financialReconciliationAudit.update.mockRejectedValueOnce(
      new Error("Database unavailable"),
    );

    await expect(service.reconcilePayout("payout-1", "admin-1")).resolves.toMatchObject({
      reconciled: false,
      providerStatus: "PENDING",
    });
    expect(databaseServiceMock.financialReconciliationAudit.update).toHaveBeenCalledTimes(1);
  });

  it("records a failed payout reconciliation attempt before rethrowing", async () => {
    databaseServiceMock.payoutTransaction.findUnique.mockResolvedValueOnce(createPayout());
    paymentServiceMock.reconcilePayout.mockRejectedValueOnce(new Error("Flutterwave unavailable"));

    await expect(service.reconcilePayout("payout-1", "admin-1")).rejects.toThrow(
      "Flutterwave unavailable",
    );
    expect(databaseServiceMock.financialReconciliationAudit.update).toHaveBeenCalledWith({
      where: { id: "audit-1" },
      data: {
        outcome: FinancialReconciliationOutcome.FAILED,
        error: "FINANCIAL_RECONCILIATION_FAILED",
      },
    });
  });
});
