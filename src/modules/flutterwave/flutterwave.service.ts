import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios, { AxiosError, AxiosInstance, AxiosRequestConfig } from "axios";
import {
  FlutterwaveConfig,
  FlutterwaveError,
  FlutterwavePaymentLinkData,
  FlutterwaveRefundData,
  FlutterwaveResponse,
  FlutterwaveTransferData,
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

  constructor(private readonly configService: ConfigService) {
    // Environment variables are validated at startup, so we can safely use them
    this.config = {
      secretKey: this.configService.get<string>("FLUTTERWAVE_SECRET_KEY"),
      publicKey: this.configService.get<string>("FLUTTERWAVE_PUBLIC_KEY"),
      baseUrl: this.configService.get<string>("FLUTTERWAVE_BASE_URL"),
      webhookSecret: this.configService.get<string>("FLUTTERWAVE_WEBHOOK_SECRET"),
      webhookUrl: this.configService.get<string>("FLUTTERWAVE_WEBHOOK_URL"),
    };

    this.httpClient = axios.create({
      baseURL: this.config.baseUrl,
      timeout: 30000, // 30 seconds
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.secretKey}`,
      },
    });

    this.setupInterceptors();
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

      const response = await this.post<FlutterwaveTransferData>("/v3/transfers", payload);

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

  async verifyTransaction(transactionId: string): Promise<FlutterwaveResponse<unknown>> {
    try {
      const response = await this.get<unknown>(`/v3/transactions/${transactionId}/verify`);
      return response;
    } catch (error) {
      this.logger.error("Failed to verify transaction", {
        error: String(error),
        transactionId,
      });
      throw error;
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

      const response = await this.post<FlutterwaveRefundData>(
        `/v3/transactions/${transactionId}/refund`,
        payload,
        {
          headers: {
            "X-Idempotency-Key": idempotencyKey,
          },
        },
      );

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

      const response = await this.post<FlutterwavePaymentLinkData>("/v3/payments", payload);

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

      throw new FlutterwaveError(
        error instanceof Error ? error.message : "Unknown error creating payment intent",
        "PAYMENT_INTENT_ERROR",
      );
    }
  }

  /**
   * Make a POST request to Flutterwave API
   */
  private async post<T>(
    endpoint: string,
    data: unknown,
    config?: AxiosRequestConfig,
  ): Promise<FlutterwaveResponse<T>> {
    try {
      this.logger.log(`Making POST request to Flutterwave: ${endpoint}`);

      const response = await this.httpClient.post<FlutterwaveResponse<T>>(endpoint, data, config);

      this.logger.log(`Flutterwave POST response: ${endpoint} - Status: ${response.data.status}`);

      return response.data;
    } catch (error) {
      throw this.handleError(error, `POST ${endpoint}`);
    }
  }

  /**
   * Make a GET request to Flutterwave API
   */
  private async get<T>(
    endpoint: string,
    config?: AxiosRequestConfig,
  ): Promise<FlutterwaveResponse<T>> {
    try {
      this.logger.log(`Making GET request to Flutterwave: ${endpoint}`);

      const response = await this.httpClient.get<FlutterwaveResponse<T>>(endpoint, config);

      this.logger.log(`Flutterwave GET response: ${endpoint} - Status: ${response.data.status}`);

      return response.data;
    } catch (error) {
      throw this.handleError(error, `GET ${endpoint}`);
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

  private setupInterceptors(): void {
    // Request interceptor to log requests (with sensitive data masked)
    this.httpClient.interceptors.request.use(
      (config) => {
        this.logger.log(`Flutterwave request: ${config.method?.toUpperCase()} ${config.url}`);
        return config;
      },
      (error) => {
        this.logger.error(`Flutterwave request error: ${error.message}`);
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      },
    );

    // Response interceptor to log responses
    this.httpClient.interceptors.response.use(
      (response) => response,
      (error) => {
        this.logger.error(`Flutterwave response error: ${error.message}`);
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  }

  private handleError(error: unknown, operation: string): FlutterwaveError {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    this.logger.error(`Flutterwave ${operation} failed: ${errorMessage}`);

    // Pass through existing FlutterwaveError instances unchanged
    if (error instanceof FlutterwaveError) {
      return error;
    }

    if (error instanceof AxiosError && error.response) {
      const { status, data } = error.response;

      return new FlutterwaveError(
        data?.message || `HTTP ${status}: ${error.response.statusText}`,
        data?.data?.code,
        status,
        data,
      );
    }

    if (error instanceof AxiosError && error.request) {
      return new FlutterwaveError(
        "Network error: Unable to reach Flutterwave servers",
        "NETWORK_ERROR",
        undefined,
        error.request,
      );
    }

    return new FlutterwaveError(
      `Unexpected error: ${errorMessage}`,
      "UNEXPECTED_ERROR",
      undefined,
      error,
    );
  }
}
