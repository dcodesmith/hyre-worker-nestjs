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
    (
      databaseService as unknown as {
        $transaction: (cb: (tx: unknown) => unknown) => Promise<unknown>;
      }
    ).$transaction = vi.fn(async (callback: (tx: unknown) => unknown) =>
      // In tests we don't need a separate transactional client; reuse the same mock.
      callback(databaseService),
    );
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  it("should have database and flutterwave services injected", () => {
    expect(databaseService).toBeDefined();
    expect(flutterwaveService).toBeDefined();
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
});
