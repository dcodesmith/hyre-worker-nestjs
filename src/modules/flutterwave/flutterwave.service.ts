import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AxiosError, AxiosInstance } from "axios";
import { EnvConfig } from "src/config/env.config";
import { HttpClientService } from "../../shared/http-client.service";
import {
  FlutterwaveConfig,
  FlutterwaveError,
  FlutterwavePaymentLinkData,
  FlutterwaveRefundData,
  FlutterwaveResponse,
  FlutterwaveTransferData,
  FlutterwaveVerificationData,
  PaymentIntentOptions,
  PaymentIntentResponse,
  PayoutRequest,
  PayoutResponse,
  RefundOptions,
  RefundResponse,
} from "./flutterwave.interface";

@Injectable()
export class FlutterwaveService {
  private readonly logger = new Logger(FlutterwaveService.name);
  private readonly config: FlutterwaveConfig;
  private readonly httpClient: AxiosInstance;

  constructor(
    private readonly configService: ConfigService<EnvConfig>,
    private readonly httpClientService: HttpClientService,
  ) {
    // Environment variables are validated at startup, so we can safely use them
    this.config = {
      secretKey: this.configService.get("FLUTTERWAVE_SECRET_KEY", { infer: true }),
      publicKey: this.configService.get("FLUTTERWAVE_PUBLIC_KEY", { infer: true }),
      baseUrl: this.configService.get("FLUTTERWAVE_BASE_URL", { infer: true }),
      webhookSecret: this.configService.get("FLUTTERWAVE_WEBHOOK_SECRET", { infer: true }),
      webhookUrl: this.configService.get("FLUTTERWAVE_WEBHOOK_URL", { infer: true }),
    };

    this.httpClient = this.httpClientService.createClient({
      baseURL: this.config.baseUrl,
      headers: {
        Authorization: `Bearer ${this.config.secretKey}`,
      },
      serviceName: "Flutterwave",
    });

    this.logger.log("Flutterwave client initialized successfully");
  }

  async initiatePayout(request: PayoutRequest): Promise<PayoutResponse> {
    const { bankDetails, amount, reference, bookingId, bookingReference } = request;

    const payload = {
      account_bank: bankDetails.bankCode,
      account_number: bankDetails.accountNumber,
      amount: amount,
      narration: `Payout for booking ${bookingReference} - ${bookingId}`,
      currency: "NGN",
      reference: reference,
      callback_url: `${this.config.webhookUrl}/api/payments/webhook/flutterwave`,
      debit_currency: "NGN",
    };

    try {
      this.logger.log("Initiating payout request", {
        payload: { ...payload, account_number: "***" }, // Mask account number in logs
      });

      const { data: response } = await this.httpClient.post<
        FlutterwaveResponse<FlutterwaveTransferData>
      >("/v3/transfers", payload);

      this.logger.log("Flutterwave transfer initiation response", {
        status: response.status,
        message: response.message,
        transferId: response.data?.id,
      });

      if (response.status === "success") {
        return {
          success: true,
          data: response.data,
        };
      }

      return {
        success: false,
        data: { message: response.message },
      };
    } catch (error) {
      this.logger.error("Failed to initiate payout via Flutterwave", {
        error: String(error),
        bookingId,
        bookingReference,
      });

      if (error instanceof FlutterwaveError) {
        return {
          success: false,
          data: { message: error.message },
        };
      }

      return {
        success: false,
        data: { message: "An unknown error occurred" },
      };
    }
  }

  async verifyTransaction(
    transactionId: string,
  ): Promise<FlutterwaveResponse<FlutterwaveVerificationData>> {
    try {
      const { data: response } = await this.httpClient.get<
        FlutterwaveResponse<FlutterwaveVerificationData>
      >(`/v3/transactions/${transactionId}/verify`);
      return response;
    } catch (error) {
      this.logger.error("Failed to verify transaction", {
        error: String(error),
        transactionId,
      });
      throw this.handleError(error, "verifyTransaction");
    }
  }

  async initiateRefund(options: RefundOptions): Promise<RefundResponse> {
    const { transactionId, amount, callbackUrl, idempotencyKey } = options;

    const payload: Record<string, unknown> = {
      amount,
    };

    if (callbackUrl) {
      payload.callback_url = callbackUrl;
    }

    try {
      this.logger.log("Initiating refund", {
        transactionId,
        amount,
        idempotencyKey,
      });

      const { data: response } = await this.httpClient.post<
        FlutterwaveResponse<FlutterwaveRefundData>
      >(`/v3/transactions/${transactionId}/refund`, payload, {
        headers: {
          "X-Idempotency-Key": idempotencyKey,
        },
      });

      if (response.status === "success" && response.data) {
        this.logger.log("Refund initiated successfully", {
          transactionId,
          refundId: response.data.id,
          amountRefunded: response.data.amount_refunded,
          status: response.data.status,
        });

        return {
          success: true,
          refundId: response.data.id,
          amountRefunded: response.data.amount_refunded,
          status: response.data.status,
        };
      }

      return {
        success: false,
        error: response.message || "Failed to initiate refund",
      };
    } catch (error) {
      this.logger.error("Failed to initiate refund", {
        error: String(error),
        transactionId,
      });

      // FlutterwaveError with a response means the API explicitly rejected the refund
      // Re-throw network/unexpected errors so caller can distinguish uncertain states
      if (error instanceof FlutterwaveError) {
        if (error.code === "NETWORK_ERROR" || error.code === "UNEXPECTED_ERROR") {
          throw error;
        }
        return {
          success: false,
          error: error.message,
        };
      }

      // Unknown error type - wrap and throw for caller to handle as uncertain state
      throw new FlutterwaveError(
        error instanceof Error ? error.message : "Unknown error initiating refund",
        "UNEXPECTED_ERROR",
      );
    }
  }

  async createPaymentIntent(options: PaymentIntentOptions): Promise<PaymentIntentResponse> {
    const txRef = options.idempotencyKey || crypto.randomUUID();

    const payload = {
      tx_ref: txRef,
      amount: Number(options.amount.toFixed(2)),
      currency: "NGN",
      redirect_url: options.callbackUrl,
      customer: {
        email: options.customer.email,
        name: options.customer.name || "Customer",
        phonenumber: options.customer.phoneNumber,
      },
      meta: { ...options.metadata, tx_ref: txRef },
      customizations: {
        title:
          options.transactionType === "booking_creation" ? "Booking Payment" : "Extension Payment",
        description:
          options.transactionType === "booking_creation"
            ? "Payment for car booking"
            : "Payment for booking extension",
      },
    };

    try {
      this.logger.log("Creating payment intent", {
        txRef,
        amount: options.amount,
        transactionType: options.transactionType,
      });

      const { data: response } = await this.httpClient.post<
        FlutterwaveResponse<FlutterwavePaymentLinkData>
      >("/v3/payments", payload);

      if (response.status === "success" && response.data?.link) {
        this.logger.log("Payment intent created successfully", {
          txRef,
          checkoutUrl: response.data.link,
        });

        return {
          paymentIntentId: txRef,
          checkoutUrl: response.data.link,
        };
      }

      throw new FlutterwaveError(
        response.message || "Failed to create payment link",
        "PAYMENT_LINK_FAILED",
      );
    } catch (error) {
      this.logger.error("Failed to create payment intent", {
        error: String(error),
        txRef,
      });

      if (error instanceof FlutterwaveError) {
        throw error;
      }

      throw this.handleError(error, "createPaymentIntent");
    }
  }

  /**
   * Get the webhook URL for callbacks
   */
  getWebhookUrl(path: string = ""): string {
    // Ensure path starts with '/' if not empty
    let sanitizedPath = "";
    if (path) {
      sanitizedPath = path.startsWith("/") ? path : `/${path}`;
    }
    return `${this.config.webhookUrl}${sanitizedPath}`;
  }

  /**
   * Get the public key for frontend integrations
   */
  getPublicKey(): string {
    return this.config.publicKey;
  }

  private handleError(error: unknown, operation: string): FlutterwaveError {
    // Pass through existing FlutterwaveError instances unchanged
    if (error instanceof FlutterwaveError) {
      return error;
    }

    // Handle network errors (request made but no response)
    if (error instanceof AxiosError && error.request && !error.response) {
      return new FlutterwaveError(
        "Network error: Unable to reach Flutterwave servers",
        "NETWORK_ERROR",
        undefined,
        error.request,
      );
    }

    const errorInfo = this.httpClientService.handleError(error, operation, "Flutterwave");

    // Extract Flutterwave-specific error details if available
    if (error instanceof AxiosError && error.response) {
      const { status, data } = error.response;
      const flutterwaveData = data as { message?: string; data?: { code?: string } };

      return new FlutterwaveError(
        flutterwaveData?.message || errorInfo.message,
        flutterwaveData?.data?.code || errorInfo.code,
        status,
        data,
      );
    }

    return new FlutterwaveError(
      errorInfo.message,
      errorInfo.code || "UNEXPECTED_ERROR",
      errorInfo.status,
      error,
    );
  }
}
