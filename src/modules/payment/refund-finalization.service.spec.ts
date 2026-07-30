import { Test, type TestingModule } from "@nestjs/testing";
import { PaymentAttemptStatus } from "@prisma/client";
import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { createPaymentRecord } from "../../shared/helper.fixtures";
import { DatabaseService } from "../database/database.service";
import { RefundStatusChangedHandler } from "../notification/handlers/refund-status-changed.handler";
import { NotificationOutboxService } from "../notification/notification-outbox.service";
import { RefundDomainStateMismatchException } from "./payment.error";
import {
  type RefundFinalizationPayment,
  RefundFinalizationService,
} from "./refund-finalization.service";

describe("RefundFinalizationService", () => {
  let service: RefundFinalizationService;
  let notificationOutboxService: NotificationOutboxService;
  const findUnique = vi.fn<(args: unknown) => Promise<RefundFinalizationPayment | null>>();
  const refundStatusChangedHandler = {} as RefundStatusChangedHandler;
  const transactionClient = {
    payment: {
      updateMany: vi.fn(),
    },
    booking: {
      updateMany: vi.fn(),
    },
    extension: {
      updateMany: vi.fn(),
    },
  };
  const booking = {
    id: "booking-123",
    bookingReference: "HYR-123",
    userId: "customer-123",
    guestUser: null,
    user: {
      id: "customer-123",
      name: "Ada Customer",
      email: "ada@example.com",
      phoneNumber: "+2348012345678",
    },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RefundFinalizationService,
        {
          provide: DatabaseService,
          useValue: {
            payment: {
              findUnique,
            },
            $transaction: vi.fn((callback: (tx: typeof transactionClient) => Promise<unknown>) =>
              callback(transactionClient),
            ),
          },
        },
        {
          provide: NotificationOutboxService,
          useValue: {
            create: vi.fn(),
          },
        },
        {
          provide: RefundStatusChangedHandler,
          useValue: refundStatusChangedHandler,
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get(RefundFinalizationService);
    notificationOutboxService = module.get(NotificationOutboxService);
    transactionClient.payment.updateMany.mockResolvedValue({ count: 1 });
    transactionClient.booking.updateMany.mockResolvedValue({ count: 1 });
    transactionClient.extension.updateMany.mockResolvedValue({ count: 1 });
  });

  it("atomically finalizes a refund and writes the customer notification", async () => {
    findUnique.mockResolvedValueOnce({
      ...createPaymentRecord({
        id: "payment-123",
        bookingId: "booking-123",
        status: PaymentAttemptStatus.REFUND_PROCESSING,
        amountCharged: new Decimal(10000),
      }),
      booking,
      extension: null,
    });

    await expect(
      service.finalize({
        paymentId: "payment-123",
        refundId: "refund-123",
        status: PaymentAttemptStatus.REFUNDED,
        amount: 10000,
        providerMetadata: {
          status: "completed",
          flutterwaveReference: "FLW-REFUND-123",
        },
      }),
    ).resolves.toBe(true);

    expect(transactionClient.payment.updateMany).toHaveBeenCalledWith({
      where: {
        id: "payment-123",
        status: {
          in: [PaymentAttemptStatus.REFUND_PROCESSING, PaymentAttemptStatus.REFUND_ERROR],
        },
      },
      data: {
        status: PaymentAttemptStatus.REFUNDED,
        webhookPayload: expect.objectContaining({
          refundAmount: 10000,
          refundStatus: "completed",
          refundFlwRef: "FLW-REFUND-123",
        }),
      },
    });
    expect(transactionClient.booking.updateMany).toHaveBeenCalledWith({
      where: {
        id: "booking-123",
        paymentStatus: {
          in: ["PAID", "REFUND_PROCESSING"],
        },
      },
      data: {
        paymentStatus: "REFUNDED",
      },
    });
    expect(transactionClient.extension.updateMany).not.toHaveBeenCalled();
    expect(notificationOutboxService.create).toHaveBeenCalledWith(
      refundStatusChangedHandler,
      {
        refundId: "refund-123",
        paymentId: "payment-123",
        bookingId: "booking-123",
        bookingReference: "HYR-123",
        status: PaymentAttemptStatus.REFUNDED,
        amount: 10000,
        failureReason: undefined,
        customer: {
          userId: "customer-123",
          name: "Ada Customer",
          email: "ada@example.com",
          phoneNumber: "+2348012345678",
        },
      },
      transactionClient,
    );
  });

  it("uses the parent booking and guest contact for an extension refund failure", async () => {
    const guestBooking = {
      ...booking,
      userId: null,
      user: null,
      guestUser: {
        name: "Guest Customer",
        email: "guest@example.com",
        phoneNumber: "+2348098765432",
      },
    };
    findUnique.mockResolvedValueOnce({
      ...createPaymentRecord({
        id: "payment-123",
        bookingId: null,
        extensionId: "extension-123",
        status: PaymentAttemptStatus.REFUND_PROCESSING,
      }),
      booking: null,
      extension: {
        bookingLeg: {
          booking: guestBooking,
        },
      },
    });

    await service.finalize({
      paymentId: "payment-123",
      refundId: "refund-123",
      status: PaymentAttemptStatus.REFUND_FAILED,
      amount: 5000,
      failureReason: "Provider rejected refund",
    });

    expect(transactionClient.extension.updateMany).toHaveBeenCalledWith({
      where: {
        id: "extension-123",
        paymentStatus: {
          in: ["PAID", "REFUND_PROCESSING"],
        },
      },
      data: {
        paymentStatus: "REFUND_FAILED",
      },
    });
    expect(transactionClient.booking.updateMany).not.toHaveBeenCalled();
    expect(notificationOutboxService.create).toHaveBeenCalledWith(
      refundStatusChangedHandler,
      expect.objectContaining({
        bookingId: "booking-123",
        status: PaymentAttemptStatus.REFUND_FAILED,
        failureReason: "Provider rejected refund",
        customer: {
          userId: undefined,
          name: "Guest Customer",
          email: "guest@example.com",
          phoneNumber: "+2348098765432",
        },
      }),
      transactionClient,
    );
  });

  it("does not create a duplicate notification when another worker finalizes first", async () => {
    findUnique.mockResolvedValueOnce({
      ...createPaymentRecord({
        id: "payment-123",
        status: PaymentAttemptStatus.REFUND_PROCESSING,
      }),
      booking,
      extension: null,
    });
    transactionClient.payment.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      service.finalize({
        paymentId: "payment-123",
        refundId: "refund-123",
        status: PaymentAttemptStatus.REFUNDED,
        amount: 10000,
      }),
    ).resolves.toBe(false);

    expect(transactionClient.booking.updateMany).not.toHaveBeenCalled();
    expect(transactionClient.extension.updateMany).not.toHaveBeenCalled();
    expect(notificationOutboxService.create).not.toHaveBeenCalled();
  });

  it("rolls back finalization when the booking refund state has changed", async () => {
    findUnique.mockResolvedValueOnce({
      ...createPaymentRecord({
        id: "payment-123",
        bookingId: "booking-123",
        status: PaymentAttemptStatus.REFUND_PROCESSING,
      }),
      booking,
      extension: null,
    });
    transactionClient.booking.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      service.finalize({
        paymentId: "payment-123",
        refundId: "refund-123",
        status: PaymentAttemptStatus.REFUNDED,
        amount: 10000,
      }),
    ).rejects.toThrow(RefundDomainStateMismatchException);

    expect(notificationOutboxService.create).not.toHaveBeenCalled();
  });

  it("skips payments that are missing or no longer in refund processing", async () => {
    findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      ...createPaymentRecord({
        id: "payment-123",
        status: PaymentAttemptStatus.REFUNDED,
      }),
      booking,
      extension: null,
    });
    const input = {
      paymentId: "payment-123",
      refundId: "refund-123",
      status: PaymentAttemptStatus.REFUNDED,
      amount: 10000,
    };

    await expect(service.finalize(input)).resolves.toBe(false);
    await expect(service.finalize(input)).resolves.toBe(false);

    expect(transactionClient.payment.updateMany).not.toHaveBeenCalled();
    expect(notificationOutboxService.create).not.toHaveBeenCalled();
  });

  it("atomically records a one-time operations handoff for manual review", async () => {
    findUnique.mockResolvedValueOnce({
      ...createPaymentRecord({
        id: "payment-123",
        bookingId: "booking-123",
        status: PaymentAttemptStatus.REFUND_PROCESSING,
        refundProviderId: "refund-123",
        refundRequestedAmount: new Decimal(5000),
      }),
      booking,
      extension: null,
    });

    await expect(
      service.requestManualReview({
        paymentId: "payment-123",
        reason: "Refund exceeded provider SLA",
      }),
    ).resolves.toBe(true);

    expect(transactionClient.payment.updateMany).toHaveBeenCalledWith({
      where: {
        id: "payment-123",
        refundManualReviewNotifiedAt: null,
        status: {
          in: [
            PaymentAttemptStatus.SUCCESSFUL,
            PaymentAttemptStatus.REFUND_PROCESSING,
            PaymentAttemptStatus.REFUND_ERROR,
          ],
        },
      },
      data: {
        refundManualReviewNotifiedAt: expect.any(Date),
      },
    });
    expect(notificationOutboxService.create).toHaveBeenCalledWith(
      refundStatusChangedHandler,
      expect.objectContaining({
        refundId: "refund-123",
        paymentId: "payment-123",
        status: "REFUND_REVIEW_REQUIRED",
        amount: 5000,
        failureReason: "Refund exceeded provider SLA",
      }),
      transactionClient,
    );
  });

  it("does not repeat a manual-review handoff", async () => {
    findUnique.mockResolvedValueOnce({
      ...createPaymentRecord({
        id: "payment-123",
        status: PaymentAttemptStatus.REFUND_PROCESSING,
        refundManualReviewNotifiedAt: new Date(),
      }),
      booking,
      extension: null,
    });

    await expect(
      service.requestManualReview({
        paymentId: "payment-123",
        reason: "Refund exceeded provider SLA",
      }),
    ).resolves.toBe(false);

    expect(notificationOutboxService.create).not.toHaveBeenCalled();
  });
});
