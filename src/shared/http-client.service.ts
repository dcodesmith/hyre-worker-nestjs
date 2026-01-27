import { Injectable, Logger } from "@nestjs/common";
import axios, { AxiosError, AxiosInstance, AxiosRequestConfig } from "axios";

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
  private readonly logger = new Logger(HttpClientService.name);

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
        this.logger.log(
          `${config.serviceName} request: ${requestConfig.method?.toUpperCase()} ${requestConfig.url}`,
        );
        return requestConfig;
      },
      (error) => {
        this.logger.error(`${config.serviceName} request error: ${error.message}`);
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      },
    );

    // Response interceptor
    client.interceptors.response.use(
      (response) => {
        this.logger.debug(
          `${config.serviceName} response: ${response.config.method?.toUpperCase()} ${response.config.url} - Status: ${response.status}`,
        );
        return response;
      },
      (error) => {
        this.logger.error(`${config.serviceName} response error: ${error.message}`);
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

    this.logger.error(`${serviceName} ${operation} failed: ${errorMessage}`);

    if (error instanceof AxiosError && error.response) {
      const { status, data } = error.response;
      return {
        message: (data as { message?: string })?.message || `HTTP ${status}: ${error.response.statusText}`,
        status,
        code: (data as { code?: string })?.code,
        isNetworkError: false,
      };
    }

    if (error instanceof AxiosError && error.request) {
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
