import { Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { FlutterwaveError } from "../flutterwave/flutterwave.interface";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";
import { PaymentIntentFailedException } from "./booking.error";
import type { CustomerDetails } from "./booking.interface";
import type { BookingFinancials } from "./booking-calculation.interface";

@Injectable()
export class BookingPaymentService {
  constructor(
    private readonly flutterwaveService: FlutterwaveService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(BookingPaymentService.name);
  }

  async createPaymentIntent(
    createdBooking: { id: string; bookingReference: string },
    financials: BookingFinancials,
    customerDetails: CustomerDetails,
  ): Promise<{ checkoutUrl: string; paymentIntentId: string }> {
    const callbackUrl = this.flutterwaveService.getWebhookUrl("/api/payments/callback");

    try {
      const paymentResult = await this.flutterwaveService.createPaymentIntent({
        amount: financials.totalAmount.toNumber(),
        customer: {
          email: customerDetails.email,
          name: customerDetails.name,
          phoneNumber: customerDetails.phoneNumber,
        },
        metadata: {
          bookingId: createdBooking.id,
          bookingReference: createdBooking.bookingReference,
          type: "booking_creation",
        },
        callbackUrl,
        transactionType: "booking_creation",
        idempotencyKey: createdBooking.id,
      });

      return {
        checkoutUrl: paymentResult.checkoutUrl,
        paymentIntentId: paymentResult.paymentIntentId,
      };
    } catch (error) {
      this.logger.error(
        {
          bookingId: createdBooking.id,
          bookingReference: createdBooking.bookingReference,
          error: error instanceof Error ? error.message : String(error),
        },
        "Payment intent creation failed",
      );

      if (error instanceof FlutterwaveError) {
        throw new PaymentIntentFailedException(error.message);
      }
      throw new PaymentIntentFailedException();
    }
  }
}
