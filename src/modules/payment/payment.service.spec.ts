import { getQueueToken } from "@nestjs/bullmq";
import { Test, TestingModule } from "@nestjs/testing";
import { PayoutTransactionStatus } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PAYOUTS_QUEUE } from "../../config/constants";
import { createBooking, createCar, createOwner } from "../../shared/helper.fixtures";
import { DatabaseService } from "../database/database.service";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";
import { PROCESS_PAYOUT_FOR_BOOKING } from "./payment.interface";
import { PaymentService } from "./payment.service";

describe("PaymentService", () => {
  let service: PaymentService;
  let databaseService: DatabaseService;
  let flutterwaveService: FlutterwaveService;
  const payoutsQueue = {
    add: vi.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        {
          provide: DatabaseService,
          useValue: {
            payoutTransaction: {
              findFirst: vi.fn().mockResolvedValue(null),
              create: vi.fn().mockResolvedValue({ id: "payout-123" }),
              update: vi.fn().mockResolvedValue({ id: "payout-123" }),
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
              update: vi.fn().mockResolvedValue({}),
            },
          },
        },
        {
          provide: FlutterwaveService,
          useValue: {
            initiatePayout: vi.fn(),
          },
        },
        {
          provide: getQueueToken(PAYOUTS_QUEUE),
          useValue: payoutsQueue,
        },
      ],
    }).compile();

    service = module.get<PaymentService>(PaymentService);
    databaseService = module.get<DatabaseService>(DatabaseService);
    flutterwaveService = module.get<FlutterwaveService>(FlutterwaveService);

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
      data: {
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
        reference: "payout_payout-123",
        meta: {},
        narration: "Payout for booking",
        complete_message: "",
        requires_approval: 0,
        is_approved: 1,
        bank_name: "Access Bank",
      },
    });

    await service.initiatePayout(booking);

    expect(flutterwaveService.initiatePayout).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(flutterwaveService.initiatePayout).mock.calls[0]?.[0];
    expect(callArgs?.reference).toBe("payout_payout-123");
  });

  // test that payout job is queued when queuePayoutForBooking is called
  it("should queue payout job when queuePayoutForBooking is called", async () => {
    const bookingId = "booking-123";
    await service.queuePayoutForBooking(bookingId);

    expect(payoutsQueue.add).toHaveBeenCalledWith(
      PROCESS_PAYOUT_FOR_BOOKING,
      expect.objectContaining({ bookingId, timestamp: expect.any(String) }),
      {
        jobId: `payout-${bookingId}`,
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 5000,
        },
      },
    );
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
        initiatedAt: new Date(),
        processedAt: null,
        completedAt: null,
        amountPaid: null,
        payoutProviderReference: null,
        notes: null,
        extensionId: null,
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

  it("should skip payout when bank details are not found", async () => {
    const booking = createBooking({
      id: "booking-123",
      fleetOwnerPayoutAmountNet: new Decimal(15000),
      car: createCar({ owner: createOwner({ id: "owner-1" }) }),
    });

    vi.mocked(databaseService.bankDetails.findUnique).mockResolvedValueOnce(null);

    await service.initiatePayout(booking);

    expect(flutterwaveService.initiatePayout).not.toHaveBeenCalled();
  });

  it("should skip payout when bank details are not verified", async () => {
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

    await service.initiatePayout(booking);

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
      initiatedAt: new Date(),
      processedAt: null,
      completedAt: null,
      amountPaid: null,
      payoutProviderReference: null,
      notes: null,
      extensionId: null,
    };

    vi.mocked(databaseService.payoutTransaction.create).mockResolvedValueOnce(payoutTransaction);
    vi.mocked(flutterwaveService.initiatePayout).mockResolvedValueOnce({
      success: false,
      data: { message: "Insufficient funds" },
    });

    await service.initiatePayout(booking);

    expect(databaseService.payoutTransaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: payoutTransaction.id },
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
      }),
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
      initiatedAt: new Date(),
      processedAt: null,
      completedAt: null,
      amountPaid: null,
      payoutProviderReference: null,
      notes: null,
      extensionId: null,
    };

    vi.mocked(databaseService.payoutTransaction.create).mockResolvedValueOnce(payoutTransaction);
    vi.mocked(flutterwaveService.initiatePayout).mockResolvedValueOnce({
      success: true,
      data: {
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
        reference: "payout_payout-123",
        meta: {},
        narration: "Payout for booking",
        complete_message: "",
        requires_approval: 0,
        is_approved: 1,
        bank_name: "Access Bank",
      },
    });

    await service.initiatePayout(booking);

    expect(databaseService.payoutTransaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: payoutTransaction.id },
        data: expect.objectContaining({
          status: "PROCESSING",
          payoutProviderReference: "12345",
        }),
      }),
    );
    expect(databaseService.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: booking.id },
        data: { overallPayoutStatus: "PROCESSING" },
      }),
    );
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

  it("should handle queue error when queueing payout", async () => {
    const bookingId = "booking-123";
    const error = new Error("Queue error");
    vi.mocked(payoutsQueue.add).mockRejectedValueOnce(error);

    await expect(service.queuePayoutForBooking(bookingId)).rejects.toThrow(error);
  });
});
