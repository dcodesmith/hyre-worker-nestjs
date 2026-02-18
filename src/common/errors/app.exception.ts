import { HttpException, HttpStatus } from "@nestjs/common";
import type { FieldError, ProblemDetails } from "./problem-details.interface";

/**
 * Base exception class for all application-specific errors.
 * Extends HttpException to include custom error codes and optional details.
 *
 * This allows for:
 * - Structured error responses with machine-readable codes
 * - Additional context for debugging
 * - Type-safe error handling
 *
 * Note: Each module defines its own error codes (e.g., JobErrorCodes, BookingErrorCodes)
 * which are co-located with the module's domain logic.
 */
export class AppException extends HttpException {
  private readonly problemDetails: ProblemDetails & {
    errorCode: string;
    errors?: FieldError[];
    details?: Record<string, unknown>;
  };
  private readonly details?: Record<string, unknown>;

  private static hasOwnKeys(value: Record<string, unknown>): boolean {
    return Object.keys(value).length > 0;
  }

  static readonly DEFAULT_TITLE = "Application Error";

  constructor(
    private readonly errorCode: string,
    message: string,
    status: HttpStatus,
    options?: {
      type?: string;
      title?: string;
      errors?: FieldError[];
      details?: Record<string, unknown>;
    },
  ) {
    const problemDetails: ProblemDetails & {
      errorCode: string;
      errors?: FieldError[];
      details?: Record<string, unknown>;
    } = {
      type: options?.type ?? errorCode,
      title: options?.title ?? AppException.DEFAULT_TITLE,
      status,
      detail: message,
      errorCode,
      ...(options?.errors && { errors: options.errors }),
      ...(options?.details &&
        AppException.hasOwnKeys(options.details) && {
          details: options.details,
        }),
    };

    super(problemDetails, status);
    this.details = options?.details;
    this.problemDetails = problemDetails;
  }

  /**
   * Get the error code
   */
  getErrorCode(): string {
    return this.errorCode;
  }

  /**
   * Get additional error details
   */
  getDetails(): Record<string, unknown> | undefined {
    return this.details;
  }

  getProblemDetails(): ProblemDetails & {
    errorCode: string;
    errors?: FieldError[];
    details?: Record<string, unknown>;
  } {
    return this.problemDetails;
  }
}
