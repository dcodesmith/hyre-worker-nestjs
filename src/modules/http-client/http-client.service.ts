import { Injectable } from "@nestjs/common";
import axios, { AxiosInstance, AxiosRequestConfig } from "axios";
import { PinoLogger } from "nestjs-pino";

export interface HttpClientConfig {
  baseURL?: string;
  timeout?: number;
  headers?: Record<string, string>;
  serviceName: string; // For logging purposes
}

export interface ErrorInfo {
  message: string;
  status?: number;
  code?: string;
  isNetworkError: boolean;
}

@Injectable()
export class HttpClientService {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(HttpClientService.name);
  }

  /**
   * Create a configured axios instance with interceptors for logging
   */
  createClient(config: HttpClientConfig): AxiosInstance {
    const axiosConfig: AxiosRequestConfig = {
      baseURL: config.baseURL,
      timeout: config.timeout ?? 30000, // Default 30 seconds
      headers: {
        "Content-Type": "application/json",
        ...config.headers,
      },
    };

    const client = axios.create(axiosConfig);

    // Request interceptor
    client.interceptors.request.use(
      (requestConfig) => {
        this.logger.info(
          {
            serviceName: config.serviceName,
            method: requestConfig.method?.toUpperCase(),
            url: requestConfig.url,
          },
          "Outgoing HTTP request",
        );
        return requestConfig;
      },
      (error) => {
        this.logger.error(
          {
            serviceName: config.serviceName,
            error: error instanceof Error ? error.message : String(error),
          },
          "HTTP request interceptor error",
        );
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      },
    );

    // Response interceptor
    client.interceptors.response.use(
      (response) => {
        this.logger.debug(
          {
            serviceName: config.serviceName,
            method: response.config.method?.toUpperCase(),
            url: response.config.url,
            status: response.status,
          },
          "Incoming HTTP response",
        );
        return response;
      },
      (error) => {
        this.logger.error(
          {
            serviceName: config.serviceName,
            error: error instanceof Error ? error.message : String(error),
          },
          "HTTP response interceptor error",
        );
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      },
    );

    return client;
  }

  /**
   * Handle axios errors and extract useful information
   */
  handleError(error: unknown, operation: string, serviceName: string): ErrorInfo {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    this.logger.error({ serviceName, operation, error: errorMessage }, "HTTP operation failed");

    if (axios.isAxiosError(error) && error.response) {
      const { status, data } = error.response;
      return {
        message:
          (data as { message?: string })?.message || `HTTP ${status}: ${error.response.statusText}`,
        status,
        code: (data as { code?: string })?.code,
        isNetworkError: false,
      };
    }

    if (axios.isAxiosError(error) && error.request) {
      return {
        message: "Network error: Unable to reach server",
        code: "NETWORK_ERROR",
        isNetworkError: true,
      };
    }

    return {
      message: `Unexpected error: ${errorMessage}`,
      code: "UNEXPECTED_ERROR",
      isNetworkError: false,
    };
  }
}
