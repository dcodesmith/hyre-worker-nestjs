import { Test, type TestingModule } from "@nestjs/testing";
import Decimal from "decimal.js";
import { describe, expect, it, vi } from "vitest";
import { FlutterwaveError } from "../flutterwave/flutterwave.interface";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";
import { PaymentIntentFailedException } from "./booking.error";
import { BookingPaymentService } from "./booking-payment.service";

describe("BookingPaymentService", () => {
  it("returns checkout url and payment intent id", async () => {
    const flutterwaveService = {
      getWebhookUrl: vi.fn().mockReturnValue("https://api.example.com/api/payments/callback"),
      createPaymentIntent: vi.fn().mockResolvedValue({
        paymentIntentId: "pi-123",
        checkoutUrl: "https://checkout.flutterwave.com/pay/abc123",
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingPaymentService,
        { provide: FlutterwaveService, useValue: flutterwaveService },
      ],
    }).compile();

    const service = module.get<BookingPaymentService>(BookingPaymentService);
    const result = await service.createPaymentIntent(
      { id: "booking-1", bookingReference: "BK-123" },
      { totalAmount: new Decimal(1000) } as never,
      { email: "user@example.com", name: "User", phoneNumber: "08012345678" },
    );

    expect(result).toEqual({
      paymentIntentId: "pi-123",
      checkoutUrl: "https://checkout.flutterwave.com/pay/abc123",
    });
  });

  it("maps FlutterwaveError to PaymentIntentFailedException", async () => {
    const flutterwaveService = {
      getWebhookUrl: vi.fn().mockReturnValue("https://api.example.com/api/payments/callback"),
      createPaymentIntent: vi
        .fn()
        .mockRejectedValue(new FlutterwaveError("Payment failed", "PAYMENT_FAILED")),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingPaymentService,
        { provide: FlutterwaveService, useValue: flutterwaveService },
      ],
    }).compile();

    const service = module.get<BookingPaymentService>(BookingPaymentService);

    await expect(
      service.createPaymentIntent(
        { id: "booking-1", bookingReference: "BK-123" },
        { totalAmount: new Decimal(1000) } as never,
        { email: "user@example.com", name: "User", phoneNumber: "08012345678" },
      ),
    ).rejects.toThrow(PaymentIntentFailedException);
  });
});
