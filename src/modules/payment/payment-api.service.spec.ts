import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { BookingStatus, PaymentStatus } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBooking, createExtension, createPayment } from "../../shared/helper.fixtures";
import { DatabaseService } from "../database/database.service";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";
import { PaymentApiService } from "./payment-api.service";

describe("PaymentApiService", () => {
  let service: PaymentApiService;
  let databaseService: DatabaseService;
  let flutterwaveService: FlutterwaveService;

  const mockUserInfo = {
    id: "user-123",
    email: "test@example.com",
    name: "Test User",
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentApiService,
        {
          provide: DatabaseService,
          useValue: {
            booking: {
              findUnique: vi.fn(),
            },
            extension: {
              findUnique: vi.fn(),
            },
            payment: {
              findFirst: vi.fn(),
              update: vi.fn(),
              updateMany: vi.fn(),
            },
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
      ],
    }).compile();

    service = module.get<PaymentApiService>(PaymentApiService);
    databaseService = module.get<DatabaseService>(DatabaseService);
    flutterwaveService = module.get<FlutterwaveService>(FlutterwaveService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
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
        metadata: {
          type: "booking",
          entityId: "booking-123",
          userId: mockUserInfo.id,
        },
      });
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
      expect(flutterwaveService.createPaymentIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          transactionType: "booking_extension",
          idempotencyKey: "extension_extension-123",
        }),
      );
    });

    it("should throw NotFoundException when booking not found", async () => {
      vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(null);

      await expect(service.initializePayment(validBookingDto, mockUserInfo)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("should throw BadRequestException when booking belongs to different user", async () => {
      const booking = createBooking({
        id: "booking-123",
        userId: "different-user",
        paymentStatus: PaymentStatus.UNPAID,
      });

      vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(booking);

      await expect(service.initializePayment(validBookingDto, mockUserInfo)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should throw BadRequestException when booking already paid", async () => {
      const booking = createBooking({
        id: "booking-123",
        userId: mockUserInfo.id,
        paymentStatus: PaymentStatus.PAID,
      });

      vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(booking);

      await expect(service.initializePayment(validBookingDto, mockUserInfo)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should throw BadRequestException when booking is cancelled", async () => {
      const booking = createBooking({
        id: "booking-123",
        userId: mockUserInfo.id,
        status: BookingStatus.CANCELLED,
        paymentStatus: PaymentStatus.UNPAID,
      });

      vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(booking);

      await expect(service.initializePayment(validBookingDto, mockUserInfo)).rejects.toThrow(
        /cancelled/i,
      );
    });

    it("should throw BadRequestException when booking is rejected", async () => {
      const booking = createBooking({
        id: "booking-123",
        userId: mockUserInfo.id,
        status: BookingStatus.REJECTED,
        paymentStatus: PaymentStatus.UNPAID,
      });

      vi.mocked(databaseService.booking.findUnique).mockResolvedValueOnce(booking);

      await expect(service.initializePayment(validBookingDto, mockUserInfo)).rejects.toThrow(
        /rejected/i,
      );
    });

    it("should throw NotFoundException when extension not found", async () => {
      const extensionDto = {
        type: "extension" as const,
        entityId: "extension-123",
        amount: 5000,
        callbackUrl: "https://example.com/callback",
      };

      vi.mocked(databaseService.extension.findUnique).mockResolvedValueOnce(null);

      await expect(service.initializePayment(extensionDto, mockUserInfo)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("should throw BadRequestException when client amount doesn't match server amount for booking", async () => {
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
        /amount mismatch/i,
      );
    });

    it("should throw BadRequestException when client amount doesn't match server amount for extension", async () => {
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
        BadRequestException,
      );
    });

    it("should throw BadRequestException when extension status is CANCELLED", async () => {
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
        /cancelled/i,
      );
    });

    it("should throw BadRequestException when extension status is REJECTED", async () => {
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
        /rejected/i,
      );
    });

    it("should throw BadRequestException when parent booking is cancelled for extension payment", async () => {
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
        /parent booking is cancelled/i,
      );
    });

    it("should throw BadRequestException when parent booking is rejected for extension payment", async () => {
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
        /parent booking is rejected/i,
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

    it("should throw NotFoundException when payment not found", async () => {
      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(null);

      await expect(service.getPaymentStatus("invalid-ref", mockUserInfo.id)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("should throw BadRequestException when user does not own payment", async () => {
      const payment = createPayment({
        booking: { id: "booking-123", status: BookingStatus.CONFIRMED, userId: "different-user" },
      });

      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(payment);

      await expect(service.getPaymentStatus("tx-ref-123", mockUserInfo.id)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe("initiateRefund", () => {
    const refundDto = { amount: 5000, reason: "Customer request" };

    it("should initiate refund successfully for booking owner", async () => {
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

      const result = await service.initiateRefund("tx-ref-123", refundDto, mockUserInfo.id);

      expect(result.success).toBe(true);
      expect(result.refundId).toBe(67890);

      expect(databaseService.payment.updateMany).toHaveBeenCalledWith({
        where: { id: "payment-123", status: { in: ["SUCCESSFUL", "REFUND_ERROR"] } },
        data: {
          status: "REFUND_PROCESSING",
          refundIdempotencyKey: expect.stringMatching(/^refund_payment-123_[a-f0-9-]+$/),
        },
      });
    });

    it("should throw NotFoundException when payment not found", async () => {
      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(null);

      await expect(
        service.initiateRefund("invalid-ref", refundDto, mockUserInfo.id),
      ).rejects.toThrow(NotFoundException);
    });

    it("should throw BadRequestException when user does not own payment", async () => {
      const payment = createPayment({
        booking: { id: "booking-123", status: BookingStatus.CONFIRMED, userId: "different-user" },
      });

      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(payment);

      await expect(
        service.initiateRefund("tx-ref-123", refundDto, mockUserInfo.id),
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw BadRequestException when payment is not successful", async () => {
      const payment = createPayment({
        status: "PENDING",
        booking: { id: "booking-123", status: BookingStatus.CONFIRMED, userId: mockUserInfo.id },
      });

      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(payment);

      await expect(
        service.initiateRefund("tx-ref-123", refundDto, mockUserInfo.id),
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw BadRequestException when refund amount exceeds amount charged", async () => {
      const payment = createPayment({
        amountCharged: new Decimal(1000), // Amount charged is less than refund request of 5000
        booking: { id: "booking-123", status: BookingStatus.CONFIRMED, userId: mockUserInfo.id },
      });

      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(payment);

      await expect(
        service.initiateRefund("tx-ref-123", refundDto, mockUserInfo.id),
      ).rejects.toThrow(/cannot exceed the amount charged/i);
    });

    it("should throw BadRequestException when payment has no charged amount", async () => {
      const payment = createPayment({
        amountCharged: null,
        booking: { id: "booking-123", status: BookingStatus.CONFIRMED, userId: mockUserInfo.id },
      });

      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(payment);

      await expect(
        service.initiateRefund("tx-ref-123", refundDto, mockUserInfo.id),
      ).rejects.toThrow(/no charged amount/i);
    });

    it("should throw BadRequestException when payment has no provider reference", async () => {
      const payment = createPayment({
        flutterwaveTransactionId: null,
        booking: { id: "booking-123", status: BookingStatus.CONFIRMED, userId: mockUserInfo.id },
      });

      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(payment);

      await expect(
        service.initiateRefund("tx-ref-123", refundDto, mockUserInfo.id),
      ).rejects.toThrow(BadRequestException);
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
      // Provider explicitly rejected - should mark as REFUND_FAILED
      expect(databaseService.payment.update).toHaveBeenCalledWith({
        where: { id: "payment-123" },
        data: { status: "REFUND_FAILED" },
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

      // Network error - set to REFUND_ERROR for reconciliation via webhook
      // The idempotency key is preserved so retries can safely use the same key
      expect(databaseService.payment.update).toHaveBeenCalledWith({
        where: { id: "payment-123" },
        data: { status: "REFUND_ERROR" },
      });
    });

    it("should throw BadRequestException when refund already in progress", async () => {
      const payment = createPayment({
        booking: { id: "booking-123", status: BookingStatus.CONFIRMED, userId: mockUserInfo.id },
      });

      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(payment);
      vi.mocked(databaseService.payment.updateMany).mockResolvedValueOnce({ count: 0 });

      await expect(
        service.initiateRefund("tx-ref-123", refundDto, mockUserInfo.id),
      ).rejects.toThrow(/already in progress/i);
    });

    it("should reuse existing idempotency key when retrying from REFUND_ERROR state", async () => {
      const existingIdempotencyKey = "refund_payment-123_existing-uuid";
      const payment = createPayment({
        status: "REFUND_ERROR",
        refundIdempotencyKey: existingIdempotencyKey,
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

      const result = await service.initiateRefund("tx-ref-123", refundDto, mockUserInfo.id);

      expect(result.success).toBe(true);

      // Should reuse the existing idempotency key for retry
      expect(databaseService.payment.updateMany).toHaveBeenCalledWith({
        where: { id: "payment-123", status: { in: ["SUCCESSFUL", "REFUND_ERROR"] } },
        data: {
          status: "REFUND_PROCESSING",
          refundIdempotencyKey: existingIdempotencyKey,
        },
      });

      // Flutterwave should be called with the same idempotency key
      expect(flutterwaveService.initiateRefund).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKey: existingIdempotencyKey,
        }),
      );
    });
  });
});
