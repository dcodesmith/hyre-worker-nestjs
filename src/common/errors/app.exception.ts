import { HttpException, HttpStatus } from "@nestjs/common";
import type { ProblemDetails } from "./problem-details.interface";

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
    details?: Record<string, unknown>;
  };

  constructor(
    private readonly errorCode: string,
    message: string,
    status: HttpStatus,
    private readonly details?: Record<string, unknown>,
  ) {
    const title = typeof details?.title === "string" ? details.title : "Application Error";
    const type = typeof details?.type === "string" ? details.type : errorCode;
    const normalizedDetails = details ? { ...details } : undefined;

    if (normalizedDetails) {
      delete normalizedDetails.title;
      delete normalizedDetails.type;
    }

    const problemDetails = {
      type,
      title,
      status,
      detail: message,
      errorCode,
      ...(normalizedDetails &&
        Object.keys(normalizedDetails).length > 0 && {
          details: normalizedDetails,
        }),
    };

    super(problemDetails, status);
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
    details?: Record<string, unknown>;
  } {
    return this.problemDetails;
  }
}
