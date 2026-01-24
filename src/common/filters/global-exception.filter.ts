import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { AppException } from "../errors/app.exception";

/**
 * Global exception filter that catches all exceptions in the application.
 * Provides consistent error responses with custom error codes and comprehensive logging.
 *
 * This filter handles:
 * - AppException (custom exceptions with error codes)
 * - HttpException and its subclasses (BadRequestException, NotFoundException, etc.)
 * - Unexpected errors (database errors, network errors, etc.)
 * - Validation errors (from ValidationPipe)
 *
 * All errors are logged with full context for debugging.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    // Get HTTP adapter for platform-agnostic response handling
    const { httpAdapter } = this.httpAdapterHost;

    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();

    // Determine HTTP status code
    const httpStatus =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    // Extract error code and details if this is an AppException
    let errorCode: string | undefined;
    let details: Record<string, unknown> | undefined;
    let errors: unknown[] | undefined;

    if (exception instanceof AppException) {
      errorCode = exception.getErrorCode();
      details = exception.getDetails();
    }

    // Extract validation errors from HttpException response
    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      if (typeof response === "object" && response !== null && "errors" in response) {
        errors = (response as { errors: unknown[] }).errors;
      }
    }

    // Determine error message
    const message = this.extractMessage(exception);

    // Log error with full context (including error code if present)
    this.logError(exception, request, httpStatus, errorCode);

    // Build error response with error code and details
    const responseBody = {
      statusCode: httpStatus,
      ...(errorCode && { errorCode }), // Include error code if present
      message,
      timestamp: new Date().toISOString(),
      path: httpAdapter.getRequestUrl(request),
      ...(details && { details }), // Include details if present
      ...(errors && { errors }), // Include validation errors if present
    };

    httpAdapter.reply(ctx.getResponse(), responseBody, httpStatus);
  }

  private extractMessage(exception: unknown): string {
    if (!(exception instanceof HttpException)) {
      return exception instanceof Error ? exception.message : "Internal server error";
    }

    const response = exception.getResponse();
    if (typeof response === "string") {
      return response;
    }

    if (typeof response === "object" && response !== null) {
      const { message: responseMessage, error } = response as {
        message?: unknown;
        error?: unknown;
      };

      if (typeof responseMessage === "string") return responseMessage;
      if (Array.isArray(responseMessage)) {
        return responseMessage
          .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
          .join(", ");
      }
      if (responseMessage !== undefined) return String(responseMessage);
      if (typeof error === "string") return error;
    }

    return exception.message;
  }

  /**
   * Log error with appropriate level and context
   */
  private logError(
    exception: unknown,
    request: { url?: string; method?: string },
    httpStatus: number,
    errorCode?: string,
  ): void {
    const url = request.url || "unknown";
    const method = request.method || "unknown";

    // Include error code in log message if present
    const errorCodePrefix = errorCode ? `[${errorCode}] ` : "";

    if (httpStatus >= 500) {
      // Server errors - log with full stack trace
      if (exception instanceof Error) {
        this.logger.error(
          `${errorCodePrefix}${method} ${url} - ${exception.message}`,
          exception.stack,
        );
      } else {
        this.logger.error(`${errorCodePrefix}${method} ${url} - Unknown error`, String(exception));
      }
    } else if (httpStatus >= 400) {
      // Client errors - log as warning
      const message = exception instanceof Error ? exception.message : String(exception);
      this.logger.warn(`${errorCodePrefix}${method} ${url} - ${message}`);
    }
  }
}
