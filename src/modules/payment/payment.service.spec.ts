import { Test, TestingModule } from "@nestjs/testing";
import { BookingStatus, PayoutTransactionStatus } from "@prisma/client";
import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import {
  createBooking,
  createCar,
  createOwner,
  createPayoutTransaction,
} from "../../shared/helper.fixtures";
import { DatabaseService } from "../database/database.service";
import type { FlutterwaveTransferData } from "../flutterwave/flutterwave.interface";
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
import { PaymentService } from "./payment.service";

const createTransfer = (reference = "payout_payout-123"): FlutterwaveTransferData => ({
  id: 12345,
  account_number: "1234567890",
  bank_code: "044",
  full_name: "Test Account",
  created_at: new Date().toISOString(),
  currency: "NGN",
  debit_currency: "NGN",
  amount: 15000,
  fee: 0,
  status: "NEW",
  reference,
  meta: {},
  narration: "Payout for booking",
  complete_message: "",
  requires_approval: 0,
  is_approved: 1,
  bank_name: "Access Bank",
});

describe("PaymentService", () => {
  let service: PaymentService;
  let databaseService: DatabaseService;
  let flutterwaveService: FlutterwaveService;
  let notificationOutboxService: NotificationOutboxService;
  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        {
          provide: DatabaseService,
          useValue: {
            payoutTransaction: {
              findFirst: vi.fn().mockResolvedValue(null),
              findMany: vi.fn().mockResolvedValue([]),
              create: vi.fn().mockResolvedValue({ id: "payout-123" }),
              update: vi.fn().mockResolvedValue({ id: "payout-123" }),
              updateMany: vi.fn().mockResolvedValue({ count: 1 }),
              findUniqueOrThrow: vi.fn().mockResolvedValue({
                ...createPayoutTransaction({
                  id: "payout-123",
                  bookingId: "booking-123",
                  amountToPay: new Decimal(15000),
                }),
                fleetOwner: createOwner({
                  id: "owner-1",
                  email: "owner@example.com",
                  phoneNumber: "+2348012345678",
                }),
              }),
            },
            bankDetails: {
              findUnique: vi.fn().mockResolvedValue({
                id: "bank-123",
                bankCode: "044",
                accountNumber: "1234567890",
                bankName: "Access Bank",
                isVerified: true,
              }),
            },
            booking: {
              findUnique: vi.fn(),
              update: vi.fn().mockResolvedValue({ bookingReference: "BR-booking-123" }),
            },
          },
        },
        {
          provide: FlutterwaveService,
          useValue: {
            initiatePayout: vi.fn(),
            findTransferByReference: vi.fn().mockResolvedValue(null),
          },
        },
        {
          provide: NotificationOutboxService,
          useValue: {
            create: vi.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: PayoutStatusChangedHandler,
          useValue: {},
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get<PaymentService>(PaymentService);
    databaseService = module.get<DatabaseService>(DatabaseService);
    flutterwaveService = module.get<FlutterwaveService>(FlutterwaveService);
    notificationOutboxService = module.get(NotificationOutboxService);

    // Mock Prisma-style $transaction helper used in PaymentService
    // In tests we don't need a separate transactional client; reuse the same mock.
    Object.assign(databaseService, {
      $transaction: vi.fn(
        async <T>(callback: (tx: DatabaseService) => Promise<T>): Promise<T> =>
          callback(databaseService),
      ),
    });
  });
  it("should use a deterministic reference derived from payout transaction id", async () => {
    const booking = createBooking({
      id: "booking-123",
      bookingReference: "BR-booking-123",
      fleetOwnerPayoutAmountNet: new Decimal(15000),
      car: createCar({ owner: createOwner({ id: "owner-1" }) }),
    });

    vi.mocked(flutterwaveService.initiatePayout).mockResolvedValueOnce({
      success: true,
      data: createTransfer(),
    });

    await service.initiatePayout(booking);

    expect(flutterwaveService.initiatePayout).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(flutterwaveService.initiatePayout).mock.calls[0]?.[0];
    expect(callArgs?.reference).toBe("payout_payout-123");
    expect(databaseService.payoutTransaction.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          payoutProviderReference: "payout_payout-123",
        }),
      }),
    );
  });

  it("reuses the booking payout transaction after a unique constraint race", async () => {
    const booking = createBooking({
      id: "booking-123",
      bookingReference: "BR-booking-123",
      fleetOwnerPayoutAmountNet: new Decimal(15000),
      car: createCar({ owner: createOwner({ id: "owner-1" }) }),
    });
    const existing = createPayoutTransaction({
      id: "existing-payout",
      bookingId: booking.id,
      status: PayoutTransactionStatus.FAILED,
    });
    vi.mocked(databaseService.payoutTransaction.create).mockRejectedValueOnce({ code: "P2002" });
    vi.mocked(databaseService.payoutTransaction.findFirst).mockResolvedValueOnce(existing);
    vi.mocked(databaseService.payoutTransaction.update).mockResolvedValueOnce(existing);
    vi.mocked(flutterwaveService.initiatePayout).mockResolvedValueOnce({
      success: true,
      data: createTransfer("payout_existing-payout"),
    });

    await service.initiatePayout(booking);

    expect(databaseService.payoutTransaction.findFirst).toHaveBeenCalledWith({
      where: { bookingId: booking.id },
    });
    expect(flutterwaveService.initiatePayout).toHaveBeenCalledWith(
      expect.objectContaining({ reference: "payout_existing-payout" }),
    );
  });

  it("throws a typed error when a raced payout transaction cannot be recovered", async () => {
    const booking = createBooking({
      id: "booking-123",
      fleetOwnerPayoutAmountNet: new Decimal(15000),
      car: createCar({ owner: createOwner({ id: "owner-1" }) }),
    });
    vi.mocked(databaseService.payoutTransaction.create).mockRejectedValueOnce({ code: "P2002" });
    vi.mocked(databaseService.payoutTransaction.findFirst).mockResolvedValueOnce(null);

    await expect(service.initiatePayout(booking)).rejects.toBeInstanceOf(
      PayoutTransactionRecoveryFailedException,
    );
  });

  it("processes payout for a completed booking", async () => {
    const booking = createBooking({
      id: "booking-123",
      status: BookingStatus.COMPLETED,
      car: createCar({ owner: createOwner({ id: "owner-1" }) }),
    });
    vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(booking);
    const initiatePayout = vi.spyOn(service, "initiatePayout").mockResolvedValueOnce(undefined);

    await service.processPayoutForBooking(booking.id);

    expect(initiatePayout).toHaveBeenCalledExactlyOnceWith(booking);
  });

  it("rejects a non-completed booking without initiating payout", async () => {
    const booking = createBooking({
      id: "booking-123",
      status: BookingStatus.ACTIVE,
      car: createCar({ owner: createOwner({ id: "owner-1" }) }),
    });
    vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(booking);
    const initiatePayout = vi.spyOn(service, "initiatePayout");

    await expect(service.processPayoutForBooking(booking.id)).rejects.toBeInstanceOf(
      PayoutBookingNotCompletedException,
    );

    expect(initiatePayout).not.toHaveBeenCalled();
  });

  it("rejects a missing booking without silently completing payout work", async () => {
    vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(null);

    await expect(service.processPayoutForBooking("missing-booking")).rejects.toBeInstanceOf(
      PayoutBookingNotFoundException,
    );
  });

  it("allows only one worker to claim payout initiation", async () => {
    const booking = createBooking({
      id: "booking-123",
      fleetOwnerPayoutAmountNet: new Decimal(15000),
      car: createCar({ owner: createOwner({ id: "owner-1" }) }),
    });
    vi.mocked(databaseService.payoutTransaction.updateMany).mockResolvedValueOnce({ count: 0 });

    await expect(service.initiatePayout(booking)).rejects.toBeInstanceOf(
      PayoutProcessingInProgressException,
    );
    expect(databaseService.payoutTransaction.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        id: "payout-123",
        OR: [
          {
            status: {
              in: [PayoutTransactionStatus.PENDING_DISBURSEMENT, PayoutTransactionStatus.FAILED],
            },
          },
          {
            status: PayoutTransactionStatus.PROCESSING,
            processingLeaseExpiresAt: { lte: expect.any(Date) },
          },
        ],
      },
      data: {
        status: PayoutTransactionStatus.PROCESSING,
        initiatedAt: expect.any(Date),
        payoutProviderReference: "payout_payout-123",
        processingLeaseId: expect.any(String),
        processingLeaseExpiresAt: expect.any(Date),
      },
    });
    expect(flutterwaveService.initiatePayout).not.toHaveBeenCalled();
  });

  it("reclaims an expired lease and reconciles the existing transfer", async () => {
    const booking = createBooking({
      id: "booking-123",
      fleetOwnerPayoutAmountNet: new Decimal(15000),
      car: createCar({ owner: createOwner({ id: "owner-1" }) }),
    });
    const payout = createPayoutTransaction({
      id: "payout-123",
      bookingId: booking.id,
      amountToPay: new Decimal(15000),
      status: PayoutTransactionStatus.PROCESSING,
      payoutProviderReference: "payout_payout-123",
      processingLeaseId: "expired-lease",
      processingLeaseExpiresAt: new Date(Date.now() - 1000),
    });
    vi.mocked(databaseService.payoutTransaction.create).mockResolvedValueOnce(payout);
    vi.mocked(flutterwaveService.findTransferByReference).mockResolvedValueOnce({
      ...createTransfer("payout_payout-123"),
      status: "SUCCESSFUL",
    });

    await service.initiatePayout(booking);

    expect(flutterwaveService.findTransferByReference).toHaveBeenCalledExactlyOnceWith(
      "payout_payout-123",
    );
    expect(flutterwaveService.initiatePayout).not.toHaveBeenCalled();
    expect(databaseService.booking.update).toHaveBeenCalledWith({
      where: { id: booking.id },
      data: { overallPayoutStatus: PayoutTransactionStatus.PAID_OUT },
      select: { bookingReference: true },
    });
    expect(notificationOutboxService.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        payoutTransactionId: payout.id,
        bookingId: booking.id,
        status: PayoutTransactionStatus.PAID_OUT,
      }),
      databaseService,
    );
  });

  it("releases a reclaimed lease when the existing transfer is still pending", async () => {
    const booking = createBooking({
      id: "booking-123",
      fleetOwnerPayoutAmountNet: new Decimal(15000),
      car: createCar({ owner: createOwner({ id: "owner-1" }) }),
    });
    const payout = createPayoutTransaction({
      id: "payout-123",
      bookingId: booking.id,
      amountToPay: new Decimal(15000),
      status: PayoutTransactionStatus.PROCESSING,
      payoutProviderReference: "payout_payout-123",
      processingLeaseId: "expired-lease",
      processingLeaseExpiresAt: new Date(Date.now() - 1000),
    });
    vi.mocked(databaseService.payoutTransaction.create).mockResolvedValueOnce(payout);
    vi.mocked(flutterwaveService.findTransferByReference).mockResolvedValueOnce(
      createTransfer("payout_payout-123"),
    );

    await service.initiatePayout(booking);

    expect(flutterwaveService.initiatePayout).not.toHaveBeenCalled();
    expect(databaseService.payoutTransaction.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: payout.id,
        status: PayoutTransactionStatus.PROCESSING,
        processingLeaseId: expect.any(String),
      },
      data: {
        processingLeaseId: null,
        processingLeaseExpiresAt: null,
      },
    });
    expect(databaseService.booking.update).not.toHaveBeenCalled();
  });

  it("throws when the payout lease is lost after provider acceptance", async () => {
    const booking = createBooking({
      id: "booking-123",
      fleetOwnerPayoutAmountNet: new Decimal(15000),
      car: createCar({ owner: createOwner({ id: "owner-1" }) }),
    });
    vi.mocked(databaseService.payoutTransaction.updateMany)
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    vi.mocked(flutterwaveService.initiatePayout).mockResolvedValueOnce({
      success: true,
      data: createTransfer(),
    });

    await expect(service.initiatePayout(booking)).rejects.toBeInstanceOf(
      PayoutProcessingClaimLostException,
    );
    expect(notificationOutboxService.create).not.toHaveBeenCalled();
  });

  it("keeps an uncertain provider call leased for reconciliation", async () => {
    const booking = createBooking({
      id: "booking-123",
      fleetOwnerPayoutAmountNet: new Decimal(15000),
      car: createCar({ owner: createOwner({ id: "owner-1" }) }),
    });
    vi.mocked(flutterwaveService.initiatePayout).mockRejectedValueOnce(new Error("Network error"));

    await expect(service.initiatePayout(booking)).rejects.toBeInstanceOf(
      PayoutInitiationFailedException,
    );

    expect(databaseService.payoutTransaction.updateMany).toHaveBeenCalledTimes(1);
    expect(databaseService.booking.update).not.toHaveBeenCalled();
  });

  it("reconciles a stale processing payout that completed at the provider", async () => {
    const payout = createPayoutTransaction({
      id: "payout-123",
      bookingId: "booking-123",
      amountToPay: new Decimal(15000),
      status: PayoutTransactionStatus.PROCESSING,
      payoutProviderReference: "payout_payout-123",
      initiatedAt: new Date(Date.now() - 20 * 60 * 1000),
      processingLeaseId: null,
      processingLeaseExpiresAt: null,
    });
    vi.mocked(databaseService.payoutTransaction.findMany).mockResolvedValueOnce([payout]);
    vi.mocked(flutterwaveService.findTransferByReference).mockResolvedValueOnce({
      ...createTransfer("payout_payout-123"),
      status: "SUCCESSFUL",
    });

    await expect(service.reconcileProcessingPayouts()).resolves.toBe(1);

    expect(databaseService.payoutTransaction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: PayoutTransactionStatus.PAID_OUT,
          amountPaid: 15000,
        }),
      }),
    );
    expect(databaseService.payoutTransaction.findMany).toHaveBeenCalledWith({
      where: {
        status: PayoutTransactionStatus.PROCESSING,
        bookingId: { not: null },
        payoutProviderReference: { not: null },
        initiatedAt: { lte: expect.any(Date) },
        OR: [
          { processingLeaseId: null },
          {
            processingLeaseExpiresAt: { lte: expect.any(Date) },
          },
        ],
      },
      orderBy: { initiatedAt: "asc" },
      take: 50,
    });
    expect(databaseService.booking.update).toHaveBeenCalledWith({
      where: { id: payout.bookingId },
      data: { overallPayoutStatus: PayoutTransactionStatus.PAID_OUT },
      select: { bookingReference: true },
    });
  });

  it("keeps a stale provider-pending payout eligible for later reconciliation", async () => {
    const payout = createPayoutTransaction({
      id: "payout-123",
      bookingId: "booking-123",
      amountToPay: new Decimal(15000),
      status: PayoutTransactionStatus.PROCESSING,
      payoutProviderReference: "payout_payout-123",
      initiatedAt: new Date(Date.now() - 20 * 60 * 1000),
      processingLeaseId: null,
      processingLeaseExpiresAt: null,
    });
    vi.mocked(databaseService.payoutTransaction.findMany).mockResolvedValueOnce([payout]);
    vi.mocked(flutterwaveService.findTransferByReference).mockResolvedValueOnce(
      createTransfer("payout_payout-123"),
    );

    await expect(service.reconcileProcessingPayouts()).resolves.toBe(0);

    expect(databaseService.payoutTransaction.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: payout.id,
        status: PayoutTransactionStatus.PROCESSING,
        processingLeaseId: expect.any(String),
      },
      data: {
        processingLeaseId: null,
        processingLeaseExpiresAt: null,
      },
    });
    expect(databaseService.booking.update).not.toHaveBeenCalled();
  });

  it("returns the provider result for a targeted payout reconciliation", async () => {
    const payout = createPayoutTransaction({
      id: "payout-123",
      bookingId: "booking-123",
      amountToPay: new Decimal(15000),
      status: PayoutTransactionStatus.PROCESSING,
      payoutProviderReference: "payout_payout-123",
      processingLeaseId: null,
      processingLeaseExpiresAt: null,
    });
    vi.mocked(flutterwaveService.findTransferByReference).mockResolvedValueOnce(
      createTransfer("payout_payout-123"),
    );

    await expect(service.reconcilePayout(payout)).resolves.toEqual({
      reconciled: false,
      providerStatus: "NEW",
      mismatchReason: null,
    });
  });

  it("does not finalize a targeted payout when Flutterwave returns mismatched details", async () => {
    const payout = createPayoutTransaction({
      id: "payout-123",
      bookingId: "booking-123",
      amountToPay: new Decimal(15000),
      status: PayoutTransactionStatus.PROCESSING,
      payoutProviderReference: "payout_payout-123",
      processingLeaseId: null,
      processingLeaseExpiresAt: null,
    });
    vi.mocked(flutterwaveService.findTransferByReference).mockResolvedValueOnce({
      ...createTransfer("different-reference"),
      status: "SUCCESSFUL",
    });

    await expect(service.reconcilePayout(payout)).resolves.toEqual({
      reconciled: false,
      providerStatus: "SUCCESSFUL",
      mismatchReason: "Flutterwave transfer reference does not match the payout reference",
    });
    expect(databaseService.booking.update).not.toHaveBeenCalled();
  });

  it("does not finalize a targeted payout for a different beneficiary", async () => {
    const payout = createPayoutTransaction({
      id: "payout-123",
      bookingId: "booking-123",
      amountToPay: new Decimal(15000),
      status: PayoutTransactionStatus.PROCESSING,
      payoutProviderReference: "payout_payout-123",
      payoutBankCode: "044",
      payoutAccountLast4: "7890",
      processingLeaseId: null,
      processingLeaseExpiresAt: null,
    });
    vi.mocked(flutterwaveService.findTransferByReference).mockResolvedValueOnce({
      ...createTransfer("payout_payout-123"),
      status: "SUCCESSFUL",
      bank_code: "058",
    });

    await expect(service.reconcilePayout(payout)).resolves.toMatchObject({
      reconciled: false,
      providerStatus: "SUCCESSFUL",
      mismatchReason: "Flutterwave transfer bank does not match the payout beneficiary",
    });
    expect(databaseService.booking.update).not.toHaveBeenCalled();
  });

  it("does not report reconciliation when failed payout finalization loses its claim", async () => {
    const payout = createPayoutTransaction({
      id: "payout-123",
      bookingId: "booking-123",
      amountToPay: new Decimal(15000),
      status: PayoutTransactionStatus.PROCESSING,
      payoutProviderReference: "payout_payout-123",
      processingLeaseId: null,
      processingLeaseExpiresAt: null,
    });
    vi.mocked(databaseService.payoutTransaction.updateMany)
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    vi.mocked(flutterwaveService.findTransferByReference).mockResolvedValueOnce({
      ...createTransfer("payout_payout-123"),
      status: "FAILED",
      complete_message: "Transfer failed",
    });

    await expect(service.reconcilePayout(payout)).resolves.toEqual({
      reconciled: false,
      providerStatus: "FAILED",
      mismatchReason: null,
    });
    expect(notificationOutboxService.create).not.toHaveBeenCalled();
  });

  it.each([[PayoutTransactionStatus.PROCESSING], [PayoutTransactionStatus.PAID_OUT]])(
    "should not retry payout when status is %s",
    async (terminalStatus) => {
      const booking = createBooking({
        id: "booking-123",
        bookingReference: "BR-booking-123",
        fleetOwnerPayoutAmountNet: new Decimal(15000),
        car: createCar({ owner: createOwner({ id: "owner-1" }) }),
      });

      // Simulate existing payout transaction already in a terminal/processing state
      vi.mocked(databaseService.payoutTransaction.create).mockResolvedValueOnce({
        id: "payout-123",
        status: terminalStatus,
        fleetOwnerId: "owner-1",
        bookingId: "booking-123",
        amountToPay: new Decimal(15000),
        currency: "NGN",
        payoutMethodDetails: "Bank: Access Bank, Account: ****7890",
        payoutBankCode: "044",
        payoutAccountLast4: "7890",
        initiatedAt: new Date(),
        processedAt: null,
        completedAt: null,
        amountPaid: null,
        payoutProviderReference: null,
        notes: null,
        extensionId: null,
        processingLeaseId: null,
        processingLeaseExpiresAt: null,
      });

      await service.initiatePayout(booking);

      expect(flutterwaveService.initiatePayout).not.toHaveBeenCalled();
    },
  );

  it("should skip payout when booking has no payout amount", async () => {
    const booking = createBooking({
      id: "booking-123",
      fleetOwnerPayoutAmountNet: new Decimal(0),
      car: createCar({ owner: createOwner() }),
    });

    await service.initiatePayout(booking);

    expect(databaseService.bankDetails.findUnique).not.toHaveBeenCalled();
    expect(flutterwaveService.initiatePayout).not.toHaveBeenCalled();
  });

  it("should reject payout when bank details are not found", async () => {
    const booking = createBooking({
      id: "booking-123",
      fleetOwnerPayoutAmountNet: new Decimal(15000),
      car: createCar({ owner: createOwner({ id: "owner-1" }) }),
    });

    vi.mocked(databaseService.bankDetails.findUnique).mockResolvedValueOnce(null);

    await expect(service.initiatePayout(booking)).rejects.toBeInstanceOf(
      PayoutBankDetailsRequiredException,
    );

    expect(flutterwaveService.initiatePayout).not.toHaveBeenCalled();
  });

  it("should reject payout when bank details are not verified", async () => {
    const booking = createBooking({
      id: "booking-123",
      fleetOwnerPayoutAmountNet: new Decimal(15000),
      car: createCar({ owner: createOwner({ id: "owner-1" }) }),
    });

    vi.mocked(databaseService.bankDetails.findUnique).mockResolvedValueOnce({
      id: "bank-123",
      bankCode: "044",
      accountNumber: "1234567890",
      accountName: "Test Account",
      bankName: "Access Bank",
      isVerified: false,
      userId: "owner-1",
      lastVerifiedAt: new Date(),
      verificationResponse: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(service.initiatePayout(booking)).rejects.toBeInstanceOf(
      PayoutBankDetailsRequiredException,
    );

    expect(flutterwaveService.initiatePayout).not.toHaveBeenCalled();
  });

  it("should handle failed payout", async () => {
    const booking = createBooking({
      id: "booking-123",
      bookingReference: "BR-booking-123",
      fleetOwnerPayoutAmountNet: new Decimal(15000),
      car: createCar({ owner: createOwner({ id: "owner-1" }) }),
    });

    const payoutTransaction = {
      id: "payout-123",
      status: "PENDING_DISBURSEMENT" as const,
      fleetOwnerId: "owner-1",
      bookingId: "booking-123",
      amountToPay: new Decimal(15000),
      currency: "NGN",
      payoutMethodDetails: "Bank: Access Bank, Account: ****7890",
      payoutBankCode: "044",
      payoutAccountLast4: "7890",
      initiatedAt: new Date(),
      processedAt: null,
      completedAt: null,
      amountPaid: null,
      payoutProviderReference: null,
      notes: null,
      extensionId: null,
      processingLeaseId: null,
      processingLeaseExpiresAt: null,
    };

    vi.mocked(databaseService.payoutTransaction.create).mockResolvedValueOnce(payoutTransaction);
    vi.mocked(flutterwaveService.initiatePayout).mockResolvedValueOnce({
      success: false,
      data: { message: "Insufficient funds" },
    });

    await expect(service.initiatePayout(booking)).rejects.toBeInstanceOf(
      PayoutInitiationFailedException,
    );

    expect(databaseService.payoutTransaction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: payoutTransaction.id,
          processingLeaseId: expect.any(String),
        }),
        data: expect.objectContaining({
          status: "FAILED",
          notes: expect.stringContaining("Insufficient funds"),
        }),
      }),
    );
    expect(databaseService.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: booking.id },
        data: { overallPayoutStatus: "FAILED" },
        select: { bookingReference: true },
      }),
    );
    expect(notificationOutboxService.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        payoutTransactionId: payoutTransaction.id,
        bookingId: booking.id,
        status: PayoutTransactionStatus.FAILED,
        failureReason: "Insufficient funds",
      }),
      databaseService,
    );
  });

  it("should handle successful payout", async () => {
    const booking = createBooking({
      id: "booking-123",
      bookingReference: "BR-booking-123",
      fleetOwnerPayoutAmountNet: new Decimal(15000),
      car: createCar({ owner: createOwner({ id: "owner-1" }) }),
    });

    const payoutTransaction = {
      id: "payout-123",
      status: "PENDING_DISBURSEMENT" as const,
      fleetOwnerId: "owner-1",
      bookingId: "booking-123",
      amountToPay: new Decimal(15000),
      currency: "NGN",
      payoutMethodDetails: "Bank: Access Bank, Account: ****7890",
      payoutBankCode: "044",
      payoutAccountLast4: "7890",
      initiatedAt: new Date(),
      processedAt: null,
      completedAt: null,
      amountPaid: null,
      payoutProviderReference: null,
      notes: null,
      extensionId: null,
      processingLeaseId: null,
      processingLeaseExpiresAt: null,
    };

    vi.mocked(databaseService.payoutTransaction.create).mockResolvedValueOnce(payoutTransaction);
    vi.mocked(flutterwaveService.initiatePayout).mockResolvedValueOnce({
      success: true,
      data: createTransfer(),
    });

    await service.initiatePayout(booking);

    expect(databaseService.payoutTransaction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: payoutTransaction.id,
          processingLeaseId: expect.any(String),
        }),
        data: expect.objectContaining({
          status: "PROCESSING",
          processingLeaseId: null,
          processingLeaseExpiresAt: null,
        }),
      }),
    );
    expect(databaseService.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: booking.id },
        data: { overallPayoutStatus: "PROCESSING" },
      }),
    );
    expect(notificationOutboxService.create).not.toHaveBeenCalled();
  });

  it("should handle errors during payout initiation", async () => {
    const booking = createBooking({
      id: "booking-123",
      fleetOwnerPayoutAmountNet: new Decimal(15000),
      car: createCar({ owner: createOwner({ id: "owner-1" }) }),
    });

    const error = new Error("Database error");
    vi.mocked(databaseService.payoutTransaction.create).mockRejectedValueOnce(error);

    await expect(service.initiatePayout(booking)).rejects.toThrow(error);
  });
});
