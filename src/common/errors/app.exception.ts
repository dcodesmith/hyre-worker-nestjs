import { HttpException, HttpStatus } from "@nestjs/common";

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
  constructor(
    public readonly errorCode: string,
    message: string,
    status: HttpStatus,
    public readonly details?: Record<string, any>,
  ) {
    super(
      {
        errorCode,
        message,
        ...(details && { details }),
      },
      status,
    );
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
  getDetails(): Record<string, any> | undefined {
    return this.details;
  }
}
