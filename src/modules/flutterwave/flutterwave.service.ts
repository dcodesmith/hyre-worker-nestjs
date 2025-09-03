import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios, { AxiosError, AxiosInstance, AxiosRequestConfig } from "axios";
import {
  FlutterwaveConfig,
  FlutterwaveError,
  FlutterwaveResponse,
  FlutterwaveTransferData,
} from "./flutterwave.types";

export interface BankDetails {
  bankCode: string;
  accountNumber: string;
  bankName?: string;
}

export interface PayoutRequest {
  bankDetails: BankDetails;
  amount: number;
  reference: string;
  bookingId: string;
}

export interface PayoutResponse {
  success: boolean;
  data: FlutterwaveTransferData | { message: string };
}

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
    const { bankDetails, amount, reference, bookingId } = request;

    const payload = {
      account_bank: bankDetails.bankCode,
      account_number: bankDetails.accountNumber,
      amount: amount,
      narration: `Payout for booking ${bookingId}`,
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

      this.logger.log("Flutterwave transfer initiation response", response);

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

  async verifyTransaction(transactionId: string): Promise<FlutterwaveResponse<any>> {
    try {
      const response = await this.get<any>(`/v3/transactions/${transactionId}/verify`);
      return response;
    } catch (error) {
      this.logger.error("Failed to verify transaction", {
        error: String(error),
        transactionId,
      });
      throw error;
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
    const sanitizedPath = path ? (path.startsWith('/') ? path : `/${path}`) : '';
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
        return Promise.reject(error);
      },
    );

    // Response interceptor to log responses
    this.httpClient.interceptors.response.use(
      (response) => {
        return response;
      },
      (error) => {
        this.logger.error(`Flutterwave response error: ${error.message}`);
        return Promise.reject(error);
      },
    );
  }

  private handleError(error: unknown, operation: string): FlutterwaveError {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    this.logger.error(`Flutterwave ${operation} failed: ${errorMessage}`);

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
