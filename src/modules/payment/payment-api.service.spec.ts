import { Test, TestingModule } from "@nestjs/testing";
import { BookingStatus, PaymentStatus } from "@prisma/client";
import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { createBooking, createExtension, createPayment } from "../../shared/helper.fixtures";
import { BOOKING_PAYMENT_SESSION_DURATION_MINUTES } from "../booking/booking.const";
import { BookingReadService } from "../booking/booking-read.service";
import { DatabaseService } from "../database/database.service";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";
import { ChargeCompletedHandler } from "./charge-completed.handler";
import {
  PaymentAccessForbiddenException,
  PaymentAmountMismatchException,
  PaymentBookingNotFoundException,
  PaymentEntityAccessForbiddenException,
  PaymentEntityAlreadyPaidException,
  PaymentEntityNotPayableException,
  PaymentExtensionNotFoundException,
  PaymentNotFoundException,
  RefundAmountExceedsChargeException,
  RefundChargedAmountMissingException,
  RefundDomainStateMismatchException,
  RefundPaymentNotSuccessfulException,
  RefundProviderReferenceMissingException,
  RefundReconciliationRequiredException,
  RefundReservationConflictException,
} from "./payment.error";
import { PaymentApiService } from "./payment-api.service";
import { RefundFinalizationService } from "./refund-finalization.service";

describe("PaymentApiService", () => {
  let service: PaymentApiService;
  let databaseService: DatabaseService;
  let flutterwaveService: FlutterwaveService;
  let refundFinalizationService: RefundFinalizationService;
  const bookingReadService = {
    getBookingPaymentStatus: vi.fn(),
  };
  const chargeCompletedHandler = {
    confirmByTransactionId: vi.fn(),
  };

  const mockUserInfo = {
    id: "user-123",
    email: "test@example.com",
    name: "Test User",
  };
  const transactionClient = {
    payment: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    booking: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    extension: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    transactionClient.booking.updateMany.mockResolvedValue({ count: 1 });
    transactionClient.extension.updateMany.mockResolvedValue({ count: 1 });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentApiService,
        {
          provide: DatabaseService,
          useValue: {
            ...transactionClient,
            $transaction: vi.fn((callback: (tx: typeof transactionClient) => Promise<unknown>) =>
              callback(transactionClient),
            ),
          },
        },
        {
          provide: FlutterwaveService,
          useValue: {
            createPaymentIntent: vi.fn(),
            initiateRefund: vi.fn(),
            getWebhookUrl: vi.fn().mockReturnValue("https://example.com/webhook"),
          },
        },
        {
          provide: RefundFinalizationService,
          useValue: {
            finalize: vi.fn().mockResolvedValue(true),
          },
        },
        { provide: BookingReadService, useValue: bookingReadService },
        { provide: ChargeCompletedHandler, useValue: chargeCompletedHandler },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get<PaymentApiService>(PaymentApiService);
    databaseService = module.get<DatabaseService>(DatabaseService);
    flutterwaveService = module.get<FlutterwaveService>(FlutterwaveService);
    refundFinalizationService = module.get<RefundFinalizationService>(RefundFinalizationService);
  });

  describe("confirmBookingPayment", () => {
    const pendingStatus = {
      bookingId: "booking-123",
      bookingReference: "BK-123",
      txRef: "tx-ref-123",
      bookingStatus: BookingStatus.PENDING,
      paymentStatus: PaymentStatus.UNPAID,
      paymentId: null,
      totalAmount: 10000,
      reservationExpiresAt: "2026-08-10T18:30:00.000Z",
      lifecycleState: "PENDING" as const,
    };

    it("verifies the callback only after checking booking access", async () => {
      bookingReadService.getBookingPaymentStatus
        .mockResolvedValueOnce(pendingStatus)
        .mockResolvedValueOnce({
          ...pendingStatus,
          bookingStatus: BookingStatus.CONFIRMED,
          paymentStatus: PaymentStatus.PAID,
          lifecycleState: "CONFIRMED",
        });

      const result = await service.confirmBookingPayment(
        {
          bookingId: "booking-123",
          txRef: "tx-ref-123",
          transactionId: "12345",
        },
        mockUserInfo as never,
      );

      expect(bookingReadService.getBookingPaymentStatus).toHaveBeenNthCalledWith(
        1,
        { bookingId: "booking-123", txRef: "tx-ref-123" },
        mockUserInfo,
        undefined,
      );
      expect(chargeCompletedHandler.confirmByTransactionId).toHaveBeenCalledWith(
        "tx-ref-123",
        "12345",
      );
      expect(result.lifecycleState).toBe("CONFIRMED");
    });

    it("does not reverify an already confirmed booking", async () => {
      bookingReadService.getBookingPaymentStatus.mockResolvedValueOnce({
        ...pendingStatus,
        bookingStatus: BookingStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
        lifecycleState: "CONFIRMED",
      });

      await service.confirmBookingPayment(
        {
          bookingId: "booking-123",
          txRef: "tx-ref-123",
          transactionId: "12345",
        },
        mockUserInfo as never,
      );

      expect(chargeCompletedHandler.confirmByTransactionId).not.toHaveBeenCalled();
    });
  });

  describe("initializePayment", () => {
    const validBookingDto = {
      type: "booking" as const,
      entityId: "booking-123",
      amount: 10000,
      callbackUrl: "https://example.com/callback",
    };

    it("should initialize payment for booking successfully", async () => {
      const booking = createBooking({
        id: "booking-123",
        userId: mockUserInfo.id,
        paymentStatus: PaymentStatus.UNPAID,
      });

      vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(booking);

      vi.mocked(flutterwaveService.createPaymentIntent).mockResolvedValueOnce({
        paymentIntentId: "pi-123",
        checkoutUrl: "https://checkout.flutterwave.com/pay/abc123",
      });

      const result = await service.initializePayment(validBookingDto, mockUserInfo);

      expect(result).toEqual({
        paymentIntentId: "pi-123",
        checkoutUrl: "https://checkout.flutterwave.com/pay/abc123",
      });

      expect(flutterwaveService.createPaymentIntent).toHaveBeenCalledWith({
        amount: 10000,
        customer: { email: mockUserInfo.email, name: mockUserInfo.name },
        callbackUrl: "https://example.com/callback",
        transactionType: "booking_creation",
        idempotencyKey: "booking_booking-123",
        sessionDurationMinutes: BOOKING_PAYMENT_SESSION_DURATION_MINUTES,
        metadata: {
          type: "booking",
          entityId: "booking-123",
          userId: mockUserInfo.id,
        },
      });
      expect(databaseService.booking.updateMany).toHaveBeenCalledWith({
        where: {
          id: "booking-123",
          status: { notIn: [BookingStatus.CANCELLED, BookingStatus.REJECTED] },
          paymentStatus: PaymentStatus.UNPAID,
          paymentIntent: null,
          paymentSessionExpiresAt: null,
        },
        data: {
          paymentIntent: "booking_booking-123",
          paymentSessionExpiresAt: expect.any(Date),
        },
      });
    });

    it("claims the booking before calling Flutterwave", async () => {
      const booking = createBooking({
        id: "booking-123",
        userId: mockUserInfo.id,
        paymentStatus: PaymentStatus.UNPAID,
      });
      vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(booking);
      vi.mocked(flutterwaveService.createPaymentIntent).mockResolvedValueOnce({
        paymentIntentId: "booking_booking-123",
        checkoutUrl: "https://checkout.flutterwave.com/pay/abc123",
      });

      await service.initializePayment(validBookingDto, mockUserInfo);

      expect(
        vi.mocked(databaseService.booking.updateMany).mock.invocationCallOrder[0],
      ).toBeLessThan(vi.mocked(flutterwaveService.createPaymentIntent).mock.invocationCallOrder[0]);
      expect(databaseService.booking.update).not.toHaveBeenCalled();
    });

    it("rejects a concurrent booking payment initialization before provider access", async () => {
      const booking = createBooking({
        id: "booking-123",
        userId: mockUserInfo.id,
        paymentStatus: PaymentStatus.UNPAID,
      });
      vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(booking);
      vi.mocked(databaseService.booking.updateMany).mockResolvedValueOnce({ count: 0 });

      await expect(service.initializePayment(validBookingDto, mockUserInfo)).rejects.toThrow(
        PaymentEntityNotPayableException,
      );
      expect(flutterwaveService.createPaymentIntent).not.toHaveBeenCalled();
    });

    it("retains the claimed reference when the provider outcome is uncertain", async () => {
      const booking = createBooking({
        id: "booking-123",
        userId: mockUserInfo.id,
        paymentStatus: PaymentStatus.UNPAID,
      });
      vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(booking);
      vi.mocked(flutterwaveService.createPaymentIntent).mockRejectedValueOnce(
        new Error("provider timeout"),
      );

      await expect(service.initializePayment(validBookingDto, mockUserInfo)).rejects.toThrow(
        "provider timeout",
      );
      expect(databaseService.booking.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            paymentIntent: "booking_booking-123",
            paymentSessionExpiresAt: expect.any(Date),
          },
        }),
      );
      expect(databaseService.booking.update).not.toHaveBeenCalled();
    });

    it("should initialize payment for extension successfully", async () => {
      const extensionDto = {
        type: "extension" as const,
        entityId: "extension-123",
        amount: 5000,
        callbackUrl: "https://example.com/callback",
      };

      const extension = createExtension({
        id: "extension-123",
        paymentStatus: PaymentStatus.UNPAID,
        bookingLeg: { booking: { userId: mockUserInfo.id, status: BookingStatus.CONFIRMED } },
      });

      vi.mocked(databaseService.extension.findUnique).mockResolvedValueOnce(extension);

      vi.mocked(flutterwaveService.createPaymentIntent).mockResolvedValueOnce({
        paymentIntentId: "pi-456",
        checkoutUrl: "https://checkout.flutterwave.com/pay/def456",
      });

      const result = await service.initializePayment(extensionDto, mockUserInfo);

      expect(result.paymentIntentId).toBe("pi-456");
      expect(databaseService.booking.updateMany).not.toHaveBeenCalled();
      expect(flutterwaveService.createPaymentIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          transactionType: "booking_extension",
          idempotencyKey: "extension_extension-123",
        }),
      );
    });

    it("throws PaymentBookingNotFoundException when booking is missing", async () => {
      vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(null);

      await expect(service.initializePayment(validBookingDto, mockUserInfo)).rejects.toThrow(
        PaymentBookingNotFoundException,
      );
    });

    it("throws PaymentEntityAccessForbiddenException for another user's booking", async () => {
      const booking = createBooking({
        id: "booking-123",
        userId: "different-user",
        paymentStatus: PaymentStatus.UNPAID,
      });

      vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(booking);

      await expect(service.initializePayment(validBookingDto, mockUserInfo)).rejects.toThrow(
        PaymentEntityAccessForbiddenException,
      );
    });

    it("throws PaymentEntityAlreadyPaidException when booking is paid", async () => {
      const booking = createBooking({
        id: "booking-123",
        userId: mockUserInfo.id,
        paymentStatus: PaymentStatus.PAID,
      });

      vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(booking);

      await expect(service.initializePayment(validBookingDto, mockUserInfo)).rejects.toThrow(
        PaymentEntityAlreadyPaidException,
      );
    });

    it("does not create a new checkout for an expired reservation", async () => {
      const booking = createBooking({
        id: "booking-123",
        userId: mockUserInfo.id,
        status: BookingStatus.PENDING,
        paymentStatus: PaymentStatus.UNPAID,
        paymentSessionExpiresAt: new Date(Date.now() - 60_000),
      });
      vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(booking);

      await expect(service.initializePayment(validBookingDto, mockUserInfo)).rejects.toThrow(
        PaymentEntityNotPayableException,
      );
      expect(flutterwaveService.createPaymentIntent).not.toHaveBeenCalled();
    });

    it("does not initialize a second checkout for an active reservation", async () => {
      const booking = createBooking({
        id: "booking-123",
        userId: mockUserInfo.id,
        status: BookingStatus.PENDING,
        paymentStatus: PaymentStatus.UNPAID,
        paymentIntent: "booking-123",
        paymentSessionExpiresAt: new Date(Date.now() + 60_000),
      });
      vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(booking);

      await expect(service.initializePayment(validBookingDto, mockUserInfo)).rejects.toThrow(
        PaymentEntityNotPayableException,
      );
      expect(flutterwaveService.createPaymentIntent).not.toHaveBeenCalled();
    });

    it.each([
      PaymentStatus.REFUND_PROCESSING,
      PaymentStatus.REFUNDED,
      PaymentStatus.PARTIALLY_REFUNDED,
      PaymentStatus.REFUND_FAILED,
    ])("rejects booking payment status %s", async (paymentStatus) => {
      const booking = createBooking({
        id: "booking-123",
        userId: mockUserInfo.id,
        paymentStatus,
      });

      vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(booking);

      await expect(service.initializePayment(validBookingDto, mockUserInfo)).rejects.toThrow(
        PaymentEntityNotPayableException,
      );
    });

    it("throws PaymentEntityNotPayableException when booking is cancelled", async () => {
      const booking = createBooking({
        id: "booking-123",
        userId: mockUserInfo.id,
        status: BookingStatus.CANCELLED,
        paymentStatus: PaymentStatus.UNPAID,
      });

      vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(booking);

      await expect(service.initializePayment(validBookingDto, mockUserInfo)).rejects.toThrow(
        PaymentEntityNotPayableException,
      );
    });

    it("throws PaymentEntityNotPayableException when booking is rejected", async () => {
      const booking = createBooking({
        id: "booking-123",
        userId: mockUserInfo.id,
        status: BookingStatus.REJECTED,
        paymentStatus: PaymentStatus.UNPAID,
      });

      vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(booking);

      await expect(service.initializePayment(validBookingDto, mockUserInfo)).rejects.toThrow(
        PaymentEntityNotPayableException,
      );
    });

    it("throws PaymentExtensionNotFoundException when extension is missing", async () => {
      const extensionDto = {
        type: "extension" as const,
        entityId: "extension-123",
        amount: 5000,
        callbackUrl: "https://example.com/callback",
      };

      vi.mocked(databaseService.extension.findUnique).mockResolvedValueOnce(null);

      await expect(service.initializePayment(extensionDto, mockUserInfo)).rejects.toThrow(
        PaymentExtensionNotFoundException,
      );
    });

    it("throws PaymentAmountMismatchException for a mismatched booking amount", async () => {
      const mismatchedDto = {
        type: "booking" as const,
        entityId: "booking-123",
        amount: 5000, // Client sends wrong amount
        callbackUrl: "https://example.com/callback",
      };

      const booking = createBooking({
        id: "booking-123",
        userId: mockUserInfo.id,
        paymentStatus: PaymentStatus.UNPAID,
        totalAmount: new Decimal(10000), // Server has different amount
      });

      vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(booking);

      await expect(service.initializePayment(mismatchedDto, mockUserInfo)).rejects.toThrow(
        PaymentAmountMismatchException,
      );
    });

    it("throws PaymentAmountMismatchException for a mismatched extension amount", async () => {
      const mismatchedDto = {
        type: "extension" as const,
        entityId: "extension-123",
        amount: 3000, // Client sends wrong amount
        callbackUrl: "https://example.com/callback",
      };

      const extension = createExtension({
        id: "extension-123",
        paymentStatus: PaymentStatus.UNPAID,
        totalAmount: new Decimal(5000), // Server has different amount
        bookingLeg: { booking: { userId: mockUserInfo.id, status: BookingStatus.CONFIRMED } },
      });

      vi.mocked(databaseService.extension.findUnique).mockResolvedValueOnce(extension);

      await expect(service.initializePayment(mismatchedDto, mockUserInfo)).rejects.toThrow(
        PaymentAmountMismatchException,
      );
    });

    it("throws PaymentEntityNotPayableException when extension is cancelled", async () => {
      const extensionDto = {
        type: "extension" as const,
        entityId: "extension-123",
        amount: 5000,
        callbackUrl: "https://example.com/callback",
      };

      const extension = createExtension({
        id: "extension-123",
        status: "CANCELLED",
        paymentStatus: PaymentStatus.UNPAID,
        bookingLeg: { booking: { userId: mockUserInfo.id, status: BookingStatus.CONFIRMED } },
      });

      vi.mocked(databaseService.extension.findUnique).mockResolvedValueOnce(extension);

      await expect(service.initializePayment(extensionDto, mockUserInfo)).rejects.toThrow(
        PaymentEntityNotPayableException,
      );
    });

    it.each([
      PaymentStatus.REFUND_PROCESSING,
      PaymentStatus.REFUNDED,
      PaymentStatus.PARTIALLY_REFUNDED,
      PaymentStatus.REFUND_FAILED,
    ])("rejects extension payment status %s", async (paymentStatus) => {
      const extensionDto = {
        type: "extension" as const,
        entityId: "extension-123",
        amount: 5000,
        callbackUrl: "https://example.com/callback",
      };
      const extension = createExtension({
        id: "extension-123",
        paymentStatus,
        bookingLeg: { booking: { userId: mockUserInfo.id, status: BookingStatus.CONFIRMED } },
      });

      vi.mocked(databaseService.extension.findUnique).mockResolvedValueOnce(extension);

      await expect(service.initializePayment(extensionDto, mockUserInfo)).rejects.toThrow(
        PaymentEntityNotPayableException,
      );
    });

    it("throws PaymentEntityNotPayableException when extension is rejected", async () => {
      const extensionDto = {
        type: "extension" as const,
        entityId: "extension-123",
        amount: 5000,
        callbackUrl: "https://example.com/callback",
      };

      const extension = createExtension({
        id: "extension-123",
        status: "REJECTED",
        paymentStatus: PaymentStatus.UNPAID,
        bookingLeg: { booking: { userId: mockUserInfo.id, status: BookingStatus.CONFIRMED } },
      });

      vi.mocked(databaseService.extension.findUnique).mockResolvedValueOnce(extension);

      await expect(service.initializePayment(extensionDto, mockUserInfo)).rejects.toThrow(
        PaymentEntityNotPayableException,
      );
    });

    it("throws PaymentEntityNotPayableException when the parent booking is cancelled", async () => {
      const extensionDto = {
        type: "extension" as const,
        entityId: "extension-123",
        amount: 5000,
        callbackUrl: "https://example.com/callback",
      };

      const extension = createExtension({
        id: "extension-123",
        status: "PENDING",
        paymentStatus: PaymentStatus.UNPAID,
        bookingLeg: { booking: { userId: mockUserInfo.id, status: BookingStatus.CANCELLED } },
      });

      vi.mocked(databaseService.extension.findUnique).mockResolvedValueOnce(extension);

      await expect(service.initializePayment(extensionDto, mockUserInfo)).rejects.toThrow(
        PaymentEntityNotPayableException,
      );
    });

    it("throws PaymentEntityNotPayableException when the parent booking is rejected", async () => {
      const extensionDto = {
        type: "extension" as const,
        entityId: "extension-123",
        amount: 5000,
        callbackUrl: "https://example.com/callback",
      };

      const extension = createExtension({
        id: "extension-123",
        status: "PENDING",
        paymentStatus: PaymentStatus.UNPAID,
        bookingLeg: { booking: { userId: mockUserInfo.id, status: BookingStatus.REJECTED } },
      });

      vi.mocked(databaseService.extension.findUnique).mockResolvedValueOnce(extension);

      await expect(service.initializePayment(extensionDto, mockUserInfo)).rejects.toThrow(
        PaymentEntityNotPayableException,
      );
    });
  });

  describe("getPaymentStatus", () => {
    it("should return payment status successfully", async () => {
      const booking = createBooking({ id: "booking-123", userId: mockUserInfo.id });
      const payment = createPayment({
        amountCharged: new Decimal(10000),
        confirmedAt: new Date("2024-01-15T10:00:00Z"),
        booking: { id: booking.id, status: booking.status, userId: booking.userId },
      });

      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(payment);

      const result = await service.getPaymentStatus("tx-ref-123", mockUserInfo.id);

      expect(result).toEqual({
        txRef: "tx-ref-123",
        status: "SUCCESSFUL",
        amountExpected: 10000,
        amountCharged: 10000,
        confirmedAt: new Date("2024-01-15T10:00:00Z"),
        booking: { id: booking.id, status: booking.status },
        extension: undefined,
      });
    });

    it("throws PaymentNotFoundException when payment is missing", async () => {
      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(null);

      await expect(service.getPaymentStatus("invalid-ref", mockUserInfo.id)).rejects.toThrow(
        PaymentNotFoundException,
      );
    });

    it("throws PaymentAccessForbiddenException when user does not own payment", async () => {
      const payment = createPayment({
        booking: { id: "booking-123", status: BookingStatus.CONFIRMED, userId: "different-user" },
      });

      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(payment);

      await expect(service.getPaymentStatus("tx-ref-123", mockUserInfo.id)).rejects.toThrow(
        PaymentAccessForbiddenException,
      );
    });
  });

  describe("initiateRefund", () => {
    const refundDto = { amount: 5000, reason: "Customer request" };

    it("defers terminal finalization until the provider response is verified", async () => {
      const payment = createPayment({
        amountCharged: new Decimal(5000),
        booking: { id: "booking-123", status: BookingStatus.CONFIRMED, userId: mockUserInfo.id },
      });

      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(payment);
      vi.mocked(databaseService.payment.updateMany).mockResolvedValueOnce({ count: 1 });

      vi.mocked(flutterwaveService.initiateRefund).mockResolvedValueOnce({
        success: true,
        refundId: 67890,
        amountRefunded: 5000,
        status: "completed-mpgs",
      });

      const result = await service.initiateRefund("tx-ref-123", refundDto, mockUserInfo.id);

      expect(result.success).toBe(true);
      expect(result.refundId).toBe(67890);
      expect(refundFinalizationService.finalize).not.toHaveBeenCalled();

      // New refund from SUCCESSFUL: WHERE clause must match exactly SUCCESSFUL (not include REFUND_ERROR)
      // This prevents race conditions where a concurrent request could overwrite the idempotency key
      expect(databaseService.payment.updateMany).toHaveBeenCalledWith({
        where: { id: "payment-123", status: "SUCCESSFUL" },
        data: {
          status: "REFUND_PROCESSING",
          refundIdempotencyKey: expect.stringMatching(/^refund_payment-123_[a-f0-9-]+$/),
          refundRequestedAmount: 5000,
          refundRequestedAt: expect.any(Date),
          refundReconciliationAttempts: 0,
          refundVerificationFailures: 0,
          refundManualReviewNotifiedAt: null,
        },
      });
      expect(transactionClient.booking.updateMany).toHaveBeenCalledWith({
        where: {
          id: "booking-123",
          paymentStatus: {
            in: [PaymentStatus.PAID, PaymentStatus.REFUND_PROCESSING],
          },
        },
        data: { paymentStatus: PaymentStatus.REFUND_PROCESSING },
      });
    });

    it("keeps an accepted but pending refund silent and in processing", async () => {
      const payment = createPayment({
        booking: { id: "booking-123", status: BookingStatus.CONFIRMED, userId: mockUserInfo.id },
      });
      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(payment);
      vi.mocked(databaseService.payment.updateMany).mockResolvedValueOnce({ count: 1 });
      vi.mocked(flutterwaveService.initiateRefund).mockResolvedValueOnce({
        success: true,
        refundId: 67890,
        amountRefunded: 5000,
        status: "completed",
      });

      await expect(
        service.initiateRefund("tx-ref-123", refundDto, mockUserInfo.id),
      ).resolves.toMatchObject({ success: true, status: "completed" });

      expect(refundFinalizationService.finalize).not.toHaveBeenCalled();
      expect(databaseService.payment.updateMany).toHaveBeenCalledWith({
        where: {
          id: "payment-123",
          status: "REFUND_PROCESSING",
        },
        data: {
          refundProviderId: "67890",
          refundProviderStatus: "completed",
          refundLastCheckedAt: expect.any(Date),
        },
      });
    });

    it("preserves the provider refund ID when local persistence becomes uncertain", async () => {
      const payment = createPayment({
        booking: { id: "booking-123", status: BookingStatus.CONFIRMED, userId: mockUserInfo.id },
      });
      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(payment);
      vi.mocked(databaseService.payment.updateMany)
        .mockResolvedValueOnce({ count: 1 })
        .mockRejectedValueOnce(new Error("Database unavailable"))
        .mockResolvedValueOnce({ count: 1 });
      vi.mocked(flutterwaveService.initiateRefund).mockResolvedValueOnce({
        success: true,
        refundId: 67890,
        amountRefunded: 5000,
        status: "completed",
      });

      await expect(
        service.initiateRefund("tx-ref-123", refundDto, mockUserInfo.id),
      ).rejects.toThrow("Database unavailable");

      expect(databaseService.payment.updateMany).toHaveBeenLastCalledWith({
        where: {
          id: "payment-123",
          status: "REFUND_PROCESSING",
        },
        data: {
          status: "REFUND_ERROR",
          refundProviderId: "67890",
          refundProviderStatus: "completed",
          refundLastCheckedAt: expect.any(Date),
        },
      });
    });

    it("throws PaymentNotFoundException when refund payment is missing", async () => {
      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(null);

      await expect(
        service.initiateRefund("invalid-ref", refundDto, mockUserInfo.id),
      ).rejects.toThrow(PaymentNotFoundException);
    });

    it("throws PaymentAccessForbiddenException when user does not own refund payment", async () => {
      const payment = createPayment({
        booking: { id: "booking-123", status: BookingStatus.CONFIRMED, userId: "different-user" },
      });

      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(payment);

      await expect(
        service.initiateRefund("tx-ref-123", refundDto, mockUserInfo.id),
      ).rejects.toThrow(PaymentAccessForbiddenException);
    });

    it("throws RefundPaymentNotSuccessfulException when payment is not successful", async () => {
      const payment = createPayment({
        status: "PENDING",
        booking: { id: "booking-123", status: BookingStatus.CONFIRMED, userId: mockUserInfo.id },
      });

      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(payment);

      await expect(
        service.initiateRefund("tx-ref-123", refundDto, mockUserInfo.id),
      ).rejects.toThrow(RefundPaymentNotSuccessfulException);
    });

    it("throws RefundAmountExceedsChargeException when refund exceeds the charge", async () => {
      const payment = createPayment({
        amountCharged: new Decimal(1000), // Amount charged is less than refund request of 5000
        booking: { id: "booking-123", status: BookingStatus.CONFIRMED, userId: mockUserInfo.id },
      });

      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(payment);

      await expect(
        service.initiateRefund("tx-ref-123", refundDto, mockUserInfo.id),
      ).rejects.toThrow(RefundAmountExceedsChargeException);
    });

    it("throws RefundChargedAmountMissingException when charged amount is missing", async () => {
      const payment = createPayment({
        amountCharged: null,
        booking: { id: "booking-123", status: BookingStatus.CONFIRMED, userId: mockUserInfo.id },
      });

      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(payment);

      await expect(
        service.initiateRefund("tx-ref-123", refundDto, mockUserInfo.id),
      ).rejects.toThrow(RefundChargedAmountMissingException);
    });

    it("throws RefundProviderReferenceMissingException when provider reference is missing", async () => {
      const payment = createPayment({
        flutterwaveTransactionId: null,
        booking: { id: "booking-123", status: BookingStatus.CONFIRMED, userId: mockUserInfo.id },
      });

      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(payment);

      await expect(
        service.initiateRefund("tx-ref-123", refundDto, mockUserInfo.id),
      ).rejects.toThrow(RefundProviderReferenceMissingException);
    });

    it("should set payment status to REFUND_FAILED when provider rejects refund", async () => {
      const payment = createPayment({
        booking: { id: "booking-123", status: BookingStatus.CONFIRMED, userId: mockUserInfo.id },
      });

      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(payment);
      vi.mocked(databaseService.payment.updateMany).mockResolvedValueOnce({ count: 1 });

      vi.mocked(flutterwaveService.initiateRefund).mockResolvedValueOnce({
        success: false,
        error: "Insufficient funds",
      });

      const result = await service.initiateRefund("tx-ref-123", refundDto, mockUserInfo.id);

      expect(result.success).toBe(false);
      expect(refundFinalizationService.finalize).toHaveBeenCalledWith({
        paymentId: "payment-123",
        refundId: expect.stringMatching(/^idempotency:refund_payment-123_[a-f0-9-]+$/),
        status: "REFUND_FAILED",
        amount: 5000,
        failureReason: "Insufficient funds",
      });
    });

    it("should set REFUND_ERROR when network error occurs during refund", async () => {
      const payment = createPayment({
        booking: { id: "booking-123", status: BookingStatus.CONFIRMED, userId: mockUserInfo.id },
      });

      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(payment);
      vi.mocked(databaseService.payment.updateMany).mockResolvedValueOnce({ count: 1 });

      vi.mocked(flutterwaveService.initiateRefund).mockRejectedValueOnce(
        new Error("Network timeout"),
      );

      await expect(
        service.initiateRefund("tx-ref-123", refundDto, mockUserInfo.id),
      ).rejects.toThrow("Network timeout");

      expect(databaseService.payment.updateMany).toHaveBeenLastCalledWith({
        where: {
          id: "payment-123",
          status: "REFUND_PROCESSING",
        },
        data: { status: "REFUND_ERROR" },
      });
    });

    it("throws RefundReservationConflictException when refund reservation loses the race", async () => {
      const payment = createPayment({
        booking: { id: "booking-123", status: BookingStatus.CONFIRMED, userId: mockUserInfo.id },
      });

      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(payment);
      vi.mocked(databaseService.payment.updateMany).mockResolvedValueOnce({ count: 0 });

      await expect(
        service.initiateRefund("tx-ref-123", refundDto, mockUserInfo.id),
      ).rejects.toThrow(RefundReservationConflictException);
    });

    it.each([
      { bookingId: null, extensionId: null },
      { bookingId: "booking-123", extensionId: "extension-123" },
    ])("rejects an invalid payment association: %o", async ({ bookingId, extensionId }) => {
      const payment = createPayment({
        bookingId,
        extensionId,
        booking: { id: "booking-123", status: BookingStatus.CONFIRMED, userId: mockUserInfo.id },
      });
      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(payment);

      await expect(
        service.initiateRefund("tx-ref-123", refundDto, mockUserInfo.id),
      ).rejects.toThrow(RefundDomainStateMismatchException);

      expect(databaseService.payment.updateMany).not.toHaveBeenCalled();
      expect(flutterwaveService.initiateRefund).not.toHaveBeenCalled();
    });

    it("allows an extension already marked as refund processing to be re-reserved", async () => {
      const payment = createPayment({
        bookingId: null,
        extensionId: "extension-123",
        booking: null,
        extension: createExtension({
          paymentStatus: PaymentStatus.REFUND_PROCESSING,
        }),
      });
      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(payment);
      vi.mocked(databaseService.payment.updateMany).mockResolvedValueOnce({ count: 1 });
      vi.mocked(flutterwaveService.initiateRefund).mockResolvedValueOnce({
        success: false,
        error: "Provider rejected refund",
      });

      await service.initiateRefund("tx-ref-123", refundDto, mockUserInfo.id);

      expect(transactionClient.extension.updateMany).toHaveBeenCalledWith({
        where: {
          id: "extension-123",
          paymentStatus: {
            in: [PaymentStatus.PAID, PaymentStatus.REFUND_PROCESSING],
          },
        },
        data: { paymentStatus: PaymentStatus.REFUND_PROCESSING },
      });
    });

    it("does not call Flutterwave when the booking refund state cannot be reserved", async () => {
      const payment = createPayment({
        booking: { id: "booking-123", status: BookingStatus.CONFIRMED, userId: mockUserInfo.id },
      });
      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(payment);
      vi.mocked(databaseService.payment.updateMany).mockResolvedValueOnce({ count: 1 });
      transactionClient.booking.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(
        service.initiateRefund("tx-ref-123", refundDto, mockUserInfo.id),
      ).rejects.toThrow(RefundDomainStateMismatchException);

      expect(flutterwaveService.initiateRefund).not.toHaveBeenCalled();
    });

    it("requires reconciliation instead of retrying an uncertain refund", async () => {
      const existingIdempotencyKey = "refund_payment-123_existing-uuid";
      const payment = createPayment({
        status: "REFUND_ERROR",
        refundIdempotencyKey: existingIdempotencyKey,
        booking: { id: "booking-123", status: BookingStatus.CONFIRMED, userId: mockUserInfo.id },
      });

      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(payment);
      await expect(
        service.initiateRefund("tx-ref-123", refundDto, mockUserInfo.id),
      ).rejects.toThrow(RefundReconciliationRequiredException);

      expect(databaseService.payment.updateMany).not.toHaveBeenCalled();
      expect(flutterwaveService.initiateRefund).not.toHaveBeenCalled();
    });
  });
});
