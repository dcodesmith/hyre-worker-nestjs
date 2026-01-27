import { HttpStatus } from "@nestjs/common";
import axios, { AxiosError, AxiosInstance, AxiosResponse } from "axios";
import { vi } from "vitest";

/**
 * Create a mock AxiosInstance for testing
 */
export function createMockAxiosInstance(): Partial<AxiosInstance> & {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  interceptors: {
    request: {
      use: ReturnType<typeof vi.fn>;
      eject: ReturnType<typeof vi.fn>;
      clear: ReturnType<typeof vi.fn>;
    };
    response: {
      use: ReturnType<typeof vi.fn>;
      eject: ReturnType<typeof vi.fn>;
      clear: ReturnType<typeof vi.fn>;
    };
  };
} {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    interceptors: {
      request: { use: vi.fn(), eject: vi.fn(), clear: vi.fn() },
      response: { use: vi.fn(), eject: vi.fn(), clear: vi.fn() },
    },
  };
}

/**
 * Create a mock HttpClientService for testing
 *
 * @param mockAxiosInstance - Optional mock axios instance to return from createClient
 * @returns Mock HttpClientService with proper handleError implementation
 */
export function createMockHttpClientService(mockAxiosInstance?: unknown): {
  createClient: ReturnType<typeof vi.fn>;
  handleError: ReturnType<typeof vi.fn>;
} {
  const mockInstance = mockAxiosInstance || createMockAxiosInstance();

  return {
    createClient: vi.fn().mockReturnValue(mockInstance),
    handleError: vi.fn((error: unknown) => {
      // Check both instanceof and isAxiosError for compatibility
      const isAxiosError =
        error instanceof AxiosError ||
        (typeof axios.isAxiosError === "function" && axios.isAxiosError(error));

      if (isAxiosError && (error as AxiosError).response) {
        const axiosError = error as AxiosError;
        return {
          message:
            (axiosError.response?.data as { message?: string })?.message ||
            `HTTP ${axiosError.response?.status}`,
          status: axiosError.response?.status,
          code: (axiosError.response?.data as { code?: string })?.code,
          isNetworkError: false,
        };
      }
      if (isAxiosError && (error as AxiosError).request) {
        return {
          message: "Network error: Unable to reach server",
          code: "NETWORK_ERROR",
          isNetworkError: true,
        };
      }
      // For non-Axios errors, extract the actual error message
      const errorMessage = error instanceof Error ? error.message : "Unexpected error";
      return {
        message: `Unexpected error: ${errorMessage}`,
        code: "UNEXPECTED_ERROR",
        isNetworkError: false,
      };
    }),
  };
}

/**
 * Standard HTTP status code to status text mapping
 */
const HTTP_STATUS_TEXTS: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: "Bad Request",
  [HttpStatus.UNAUTHORIZED]: "Unauthorized",
  [HttpStatus.FORBIDDEN]: "Forbidden",
  [HttpStatus.NOT_FOUND]: "Not Found",
  [HttpStatus.TOO_MANY_REQUESTS]: "Too Many Requests",
  [HttpStatus.INTERNAL_SERVER_ERROR]: "Internal Server Error",
  [HttpStatus.BAD_GATEWAY]: "Bad Gateway",
  [HttpStatus.SERVICE_UNAVAILABLE]: "Service Unavailable",
} as const;

/**
 * Create an AxiosError with a response for testing
 * Automatically maps status codes to standard HTTP status texts
 *
 * @param status - HTTP status code
 * @param data - Optional response data
 */
export function createAxiosErrorWithResponse<T = unknown>(
  status: HttpStatus,
  data?: T,
): AxiosError<T> {
  const statusText = HTTP_STATUS_TEXTS[status] || "Error";
  const error = new AxiosError<T>(statusText);
  error.response = {
    status,
    statusText,
    data,
    headers: {},
    config: {} as never, // AxiosRequestConfig is complex, safe to use never here
  } as AxiosResponse<T>;
  return error;
}

/**
 * Create an AxiosError with a request (network error) for testing
 * Used when request was made but no response received
 */
export function createAxiosErrorWithRequest(message: string): AxiosError {
  const error = new AxiosError(message);
  error.request = {};
  return error;
}
