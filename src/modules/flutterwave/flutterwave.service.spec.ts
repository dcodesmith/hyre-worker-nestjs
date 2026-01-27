import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import axios from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockAxiosInstance,
  createMockHttpClientService,
} from "../http-client/http-client.fixtures";
import { HttpClientService } from "../http-client/http-client.service";
import { FlutterwaveError, PaymentIntentOptions, RefundOptions } from "./flutterwave.interface";
import { FlutterwaveService } from "./flutterwave.service";

describe("FlutterwaveService", () => {
  let service: FlutterwaveService;
  let mockAxiosInstance: ReturnType<typeof createMockAxiosInstance>;

  const mockConfig = {
    FLUTTERWAVE_SECRET_KEY: "test-secret-key",
    FLUTTERWAVE_PUBLIC_KEY: "test-public-key",
    FLUTTERWAVE_BASE_URL: "https://api.flutterwave.com",
    FLUTTERWAVE_WEBHOOK_SECRET: "test-webhook-secret",
    FLUTTERWAVE_WEBHOOK_URL: "https://example.com/webhooks",
  };

  beforeEach(async () => {
    mockAxiosInstance = createMockAxiosInstance();
    const mockHttpClientService = createMockHttpClientService(mockAxiosInstance);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FlutterwaveService,
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn((key: string) => mockConfig[key as keyof typeof mockConfig]),
          },
        },
        { provide: HttpClientService, useValue: mockHttpClientService },
      ],
    }).compile();

    service = module.get<FlutterwaveService>(FlutterwaveService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("createPaymentIntent", () => {
    const validOptions: PaymentIntentOptions = {
      amount: 10000,
      customer: {
        email: "test@example.com",
        name: "Test User",
        phoneNumber: "08012345678",
      },
      callbackUrl: "https://example.com/callback",
      transactionType: "booking_creation",
      metadata: { bookingId: "booking-123" },
    };

    it("should create payment intent successfully", async () => {
      const mockResponse = {
        data: {
          status: "success",
          message: "Payment link created",
          data: {
            link: "https://checkout.flutterwave.com/v3/hosted/pay/abc123",
          },
        },
      };

      mockAxiosInstance.post.mockResolvedValueOnce(mockResponse);

      const result = await service.createPaymentIntent(validOptions);

      expect(result).toEqual({
        paymentIntentId: expect.any(String),
        checkoutUrl: "https://checkout.flutterwave.com/v3/hosted/pay/abc123",
      });

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        "/v3/payments",
        expect.objectContaining({
          amount: 10000,
          currency: "NGN",
          redirect_url: "https://example.com/callback",
          customer: {
            email: "test@example.com",
            name: "Test User",
            phonenumber: "08012345678",
          },
          customizations: {
            title: "Booking Payment",
            description: "Payment for car booking",
          },
        }),
      );
    });

    it("should use provided idempotencyKey as tx_ref", async () => {
      const optionsWithKey: PaymentIntentOptions = {
        ...validOptions,
        idempotencyKey: "custom-tx-ref-123",
      };

      const mockResponse = {
        data: {
          status: "success",
          message: "Payment link created",
          data: {
            link: "https://checkout.flutterwave.com/v3/hosted/pay/abc123",
          },
        },
      };

      mockAxiosInstance.post.mockResolvedValueOnce(mockResponse);

      const result = await service.createPaymentIntent(optionsWithKey);

      expect(result.paymentIntentId).toBe("custom-tx-ref-123");
      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        "/v3/payments",
        expect.objectContaining({
          tx_ref: "custom-tx-ref-123",
        }),
      );
    });

    it("should use correct customizations for booking_extension", async () => {
      const extensionOptions: PaymentIntentOptions = {
        ...validOptions,
        transactionType: "booking_extension",
      };

      const mockResponse = {
        data: {
          status: "success",
          message: "Payment link created",
          data: {
            link: "https://checkout.flutterwave.com/v3/hosted/pay/abc123",
          },
        },
      };

      mockAxiosInstance.post.mockResolvedValueOnce(mockResponse);

      await service.createPaymentIntent(extensionOptions);

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        "/v3/payments",
        expect.objectContaining({
          customizations: {
            title: "Extension Payment",
            description: "Payment for booking extension",
          },
        }),
      );
    });

    it("should use default customer name when not provided", async () => {
      const optionsWithoutName: PaymentIntentOptions = {
        ...validOptions,
        customer: {
          email: "test@example.com",
        },
      };

      const mockResponse = {
        data: {
          status: "success",
          message: "Payment link created",
          data: {
            link: "https://checkout.flutterwave.com/v3/hosted/pay/abc123",
          },
        },
      };

      mockAxiosInstance.post.mockResolvedValueOnce(mockResponse);

      await service.createPaymentIntent(optionsWithoutName);

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        "/v3/payments",
        expect.objectContaining({
          customer: expect.objectContaining({
            name: "Customer",
          }),
        }),
      );
    });

    it("should throw FlutterwaveError when API returns non-success status", async () => {
      const mockResponse = {
        data: {
          status: "error",
          message: "Invalid customer email",
          data: null,
        },
      };

      mockAxiosInstance.post.mockResolvedValue(mockResponse);

      await expect(service.createPaymentIntent(validOptions)).rejects.toMatchObject({
        name: "FlutterwaveError",
        message: "Invalid customer email",
      });
    });

    it("should throw FlutterwaveError when API returns success but no link", async () => {
      const mockResponse = {
        data: {
          status: "success",
          message: "Payment link created",
          data: {},
        },
      };

      mockAxiosInstance.post.mockResolvedValueOnce(mockResponse);

      await expect(service.createPaymentIntent(validOptions)).rejects.toThrow(FlutterwaveError);
    });

    it("should handle network errors", async () => {
      const networkError = new axios.AxiosError("Network Error");
      networkError.request = {};
      mockAxiosInstance.post.mockRejectedValue(networkError);

      await expect(service.createPaymentIntent(validOptions)).rejects.toMatchObject({
        name: "FlutterwaveError",
        message: "Network error: Unable to reach Flutterwave servers",
      });
    });

    it("should include metadata in request payload", async () => {
      const optionsWithMetadata: PaymentIntentOptions = {
        ...validOptions,
        metadata: {
          bookingId: "booking-123",
          extensionId: "ext-456",
          userId: "user-789",
        },
      };

      const mockResponse = {
        data: {
          status: "success",
          message: "Payment link created",
          data: {
            link: "https://checkout.flutterwave.com/v3/hosted/pay/abc123",
          },
        },
      };

      mockAxiosInstance.post.mockResolvedValueOnce(mockResponse);

      await service.createPaymentIntent(optionsWithMetadata);

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        "/v3/payments",
        expect.objectContaining({
          meta: expect.objectContaining({
            bookingId: "booking-123",
            extensionId: "ext-456",
            userId: "user-789",
          }),
        }),
      );
    });
  });

  describe("verifyTransaction", () => {
    it("should verify transaction successfully", async () => {
      const mockResponse = {
        data: {
          status: "success",
          message: "Transaction verified",
          data: {
            id: 12345,
            tx_ref: "tx-ref-123",
            amount: 10000,
            currency: "NGN",
            status: "successful",
          },
        },
      };

      mockAxiosInstance.get.mockResolvedValueOnce(mockResponse);

      const result = await service.verifyTransaction("12345");

      expect(result).toEqual({
        status: "success",
        message: "Transaction verified",
        data: expect.objectContaining({
          id: 12345,
          status: "successful",
        }),
      });

      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/v3/transactions/12345/verify");
    });

    it("should throw error when verification fails", async () => {
      const error = new Error("Transaction not found");
      mockAxiosInstance.get.mockRejectedValueOnce(error);

      await expect(service.verifyTransaction("invalid-id")).rejects.toThrow();
    });
  });

  describe("initiatePayout", () => {
    it("should initiate payout successfully", async () => {
      const mockResponse = {
        data: {
          status: "success",
          message: "Transfer initiated",
          data: {
            id: 12345,
            account_number: "1234567890",
            bank_code: "044",
            full_name: "Test Account",
            amount: 15000,
            status: "NEW",
            reference: "payout-ref-123",
          },
        },
      };

      mockAxiosInstance.post.mockResolvedValueOnce(mockResponse);

      const result = await service.initiatePayout({
        bankDetails: {
          bankCode: "044",
          accountNumber: "1234567890",
        },
        amount: 15000,
        reference: "payout-ref-123",
        bookingId: "booking-123",
        bookingReference: "BR-123",
      });

      expect(result.success).toBe(true);
      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        "/v3/transfers",
        expect.objectContaining({
          account_bank: "044",
          account_number: "1234567890",
          amount: 15000,
          currency: "NGN",
          reference: "payout-ref-123",
        }),
      );
    });

    it("should return failure when payout fails", async () => {
      const mockResponse = {
        data: {
          status: "error",
          message: "Insufficient funds",
          data: null,
        },
      };

      mockAxiosInstance.post.mockResolvedValueOnce(mockResponse);

      const result = await service.initiatePayout({
        bankDetails: {
          bankCode: "044",
          accountNumber: "1234567890",
        },
        amount: 15000,
        reference: "payout-ref-123",
        bookingId: "booking-123",
        bookingReference: "BR-123",
      });

      expect(result.success).toBe(false);
      expect(result.data).toEqual({ message: "Insufficient funds" });
    });
  });

  describe("initiateRefund", () => {
    const validRefundOptions: RefundOptions = {
      transactionId: "12345",
      amount: 5000,
      idempotencyKey: "refund_payment-123_test-uuid",
    };

    it("should initiate refund successfully", async () => {
      const mockResponse = {
        data: {
          status: "success",
          message: "Refund initiated",
          data: {
            id: 67890,
            account_id: 123,
            tx_id: 12345,
            flw_ref: "FLW-MOCK-REF",
            wallet_id: 456,
            amount_refunded: 5000,
            status: "completed",
            destination: "card",
            meta: {},
            created_at: "2024-01-15T10:00:00.000Z",
          },
        },
      };

      mockAxiosInstance.post.mockResolvedValueOnce(mockResponse);

      const result = await service.initiateRefund(validRefundOptions);

      expect(result).toEqual({
        success: true,
        refundId: 67890,
        amountRefunded: 5000,
        status: "completed",
      });

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        "/v3/transactions/12345/refund",
        { amount: 5000 },
        {
          headers: {
            "X-Idempotency-Key": "refund_payment-123_test-uuid",
          },
        },
      );
    });

    it("should include callback_url when provided", async () => {
      const optionsWithCallback: RefundOptions = {
        ...validRefundOptions,
        callbackUrl: "https://example.com/refund-callback",
      };

      const mockResponse = {
        data: {
          status: "success",
          message: "Refund initiated",
          data: {
            id: 67890,
            account_id: 123,
            tx_id: 12345,
            flw_ref: "FLW-MOCK-REF",
            wallet_id: 456,
            amount_refunded: 5000,
            status: "completed",
            destination: "card",
            meta: {},
            created_at: "2024-01-15T10:00:00.000Z",
          },
        },
      };

      mockAxiosInstance.post.mockResolvedValueOnce(mockResponse);

      await service.initiateRefund(optionsWithCallback);

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        "/v3/transactions/12345/refund",
        {
          amount: 5000,
          callback_url: "https://example.com/refund-callback",
        },
        {
          headers: {
            "X-Idempotency-Key": "refund_payment-123_test-uuid",
          },
        },
      );
    });

    it("should return failure when API returns non-success status", async () => {
      const mockResponse = {
        data: {
          status: "error",
          message: "Transaction not found",
          data: null,
        },
      };

      mockAxiosInstance.post.mockResolvedValueOnce(mockResponse);

      const result = await service.initiateRefund(validRefundOptions);

      expect(result).toEqual({
        success: false,
        error: "Transaction not found",
      });
    });

    it("should return failure when API returns success but no data", async () => {
      const mockResponse = {
        data: {
          status: "success",
          message: "Refund initiated",
          data: null,
        },
      };

      mockAxiosInstance.post.mockResolvedValueOnce(mockResponse);

      const result = await service.initiateRefund(validRefundOptions);

      expect(result).toEqual({
        success: false,
        error: "Refund initiated",
      });
    });

    it("should handle FlutterwaveError from handleError", async () => {
      // When the post method throws, handleError wraps it as FlutterwaveError
      // The catch block in initiateRefund then extracts the message
      const flutterwaveError = new FlutterwaveError("Invalid transaction ID", "INVALID_TX");
      mockAxiosInstance.post.mockRejectedValueOnce(flutterwaveError);

      const result = await service.initiateRefund(validRefundOptions);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid transaction ID");
    });

    it("should throw network errors for caller to handle as uncertain state", async () => {
      // Network errors should be thrown so caller can distinguish uncertain states
      // from explicit rejections and handle appropriately (e.g., REFUND_ERROR vs REFUND_FAILED)
      const networkError = new FlutterwaveError(
        "Network error: Unable to reach Flutterwave servers",
        "NETWORK_ERROR",
      );
      mockAxiosInstance.post.mockRejectedValueOnce(networkError);

      await expect(service.initiateRefund(validRefundOptions)).rejects.toMatchObject({
        message: "Network error: Unable to reach Flutterwave servers",
        code: "NETWORK_ERROR",
      });
    });

    it("should throw unknown errors for caller to handle as uncertain state", async () => {
      // Unknown errors should be thrown wrapped as FlutterwaveError with UNEXPECTED_ERROR code
      const unknownError = new Error("Something unexpected happened");
      mockAxiosInstance.post.mockRejectedValueOnce(unknownError);

      await expect(service.initiateRefund(validRefundOptions)).rejects.toMatchObject({
        message: expect.stringContaining("Something unexpected happened"),
        code: "UNEXPECTED_ERROR",
      });
    });
  });

  describe("getWebhookUrl", () => {
    it("should return webhook URL with path", () => {
      const url = service.getWebhookUrl("/api/payments/webhook");
      expect(url).toBe("https://example.com/webhooks/api/payments/webhook");
    });

    it("should return webhook URL without path", () => {
      const url = service.getWebhookUrl();
      expect(url).toBe("https://example.com/webhooks");
    });

    it("should handle path without leading slash", () => {
      const url = service.getWebhookUrl("api/payments/webhook");
      expect(url).toBe("https://example.com/webhooks/api/payments/webhook");
    });
  });

  describe("getPublicKey", () => {
    it("should return public key", () => {
      const publicKey = service.getPublicKey();
      expect(publicKey).toBe("test-public-key");
    });
  });
});
