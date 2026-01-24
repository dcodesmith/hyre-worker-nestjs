import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { PaymentStatus } from "@prisma/client";
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
        bookingLeg: { booking: { userId: mockUserInfo.id } },
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
  });

  describe("getPaymentStatus", () => {
    it("should return payment status successfully", async () => {
      const booking = createBooking({ id: "booking-123", userId: mockUserInfo.id });
      const payment = createPayment({
        status: "SUCCESSFUL",
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
        status: "SUCCESSFUL",
        booking: { id: "booking-123", status: "CONFIRMED", userId: "different-user" },
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
        status: "SUCCESSFUL",
        booking: { id: "booking-123", status: "CONFIRMED", userId: mockUserInfo.id },
      });

      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(payment);

      vi.mocked(flutterwaveService.initiateRefund).mockResolvedValueOnce({
        success: true,
        refundId: 67890,
        amountRefunded: 5000,
        status: "completed",
      });

      vi.mocked(databaseService.payment.update).mockResolvedValueOnce({
        ...payment,
        status: "REFUND_PROCESSING",
      });

      const result = await service.initiateRefund("tx-ref-123", refundDto, mockUserInfo.id);

      expect(result.success).toBe(true);
      expect(result.refundId).toBe(67890);

      expect(databaseService.payment.update).toHaveBeenCalledWith({
        where: { id: "payment-123" },
        data: { status: "REFUND_PROCESSING" },
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
        status: "SUCCESSFUL",
        booking: { id: "booking-123", status: "CONFIRMED", userId: "different-user" },
      });

      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(payment);

      await expect(
        service.initiateRefund("tx-ref-123", refundDto, mockUserInfo.id),
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw BadRequestException when payment is not successful", async () => {
      const payment = createPayment({
        status: "PENDING",
        booking: { id: "booking-123", status: "CONFIRMED", userId: mockUserInfo.id },
      });

      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(payment);

      await expect(
        service.initiateRefund("tx-ref-123", refundDto, mockUserInfo.id),
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw BadRequestException when refund amount exceeds payment", async () => {
      const payment = createPayment({
        status: "SUCCESSFUL",
        amountExpected: new Decimal(1000),
        booking: { id: "booking-123", status: "CONFIRMED", userId: mockUserInfo.id },
      });

      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(payment);

      await expect(
        service.initiateRefund("tx-ref-123", refundDto, mockUserInfo.id),
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw BadRequestException when payment has no provider reference", async () => {
      const payment = createPayment({
        status: "SUCCESSFUL",
        flutterwaveTransactionId: null,
        booking: { id: "booking-123", status: "CONFIRMED", userId: mockUserInfo.id },
      });

      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(payment);

      await expect(
        service.initiateRefund("tx-ref-123", refundDto, mockUserInfo.id),
      ).rejects.toThrow(BadRequestException);
    });

    it("should not update payment status when refund fails", async () => {
      const payment = createPayment({
        status: "SUCCESSFUL",
        booking: { id: "booking-123", status: "CONFIRMED", userId: mockUserInfo.id },
      });

      vi.mocked(databaseService.payment.findFirst).mockResolvedValueOnce(payment);

      vi.mocked(flutterwaveService.initiateRefund).mockResolvedValueOnce({
        success: false,
        error: "Insufficient funds",
      });

      const result = await service.initiateRefund("tx-ref-123", refundDto, mockUserInfo.id);

      expect(result.success).toBe(false);
      expect(databaseService.payment.update).not.toHaveBeenCalled();
    });
  });
});
