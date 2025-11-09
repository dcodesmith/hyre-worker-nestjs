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
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    // Extract error code and details if this is an AppException
    let errorCode: string | undefined;
    let details: Record<string, unknown> | undefined;

    if (exception instanceof AppException) {
      errorCode = exception.getErrorCode();
      details = exception.getDetails();
    }

    // Determine error message
    let message: string;
    if (exception instanceof HttpException) {
      const exceptionResponse = exception.getResponse();
      if (typeof exceptionResponse === "string") {
        message = exceptionResponse;
      } else if (typeof exceptionResponse === "object" && exceptionResponse !== null) {
        // For AppException, extract the message from the response object
        message = (exceptionResponse as Record<string, unknown>).message as string || "Internal server error";
      } else {
        message = "Internal server error";
      }
    } else if (exception instanceof Error) {
      message = exception.message;
    } else {
      message = "Internal server error";
    }

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
    };

    httpAdapter.reply(ctx.getResponse(), responseBody, httpStatus);
  }

  /**
   * Log error with appropriate level and context
   */
  private logError(
    exception: unknown,
    request: Request,
    httpStatus: number,
    errorCode?: string,
  ): void {
    const url = (request as unknown as { url?: string }).url || "unknown";
    const method = (request as unknown as { method?: string }).method || "unknown";

    // Include error code in log message if present
    const errorCodePrefix = errorCode ? `[${errorCode}] ` : "";

    if (httpStatus >= 500) {
      // Server errors - log with full stack trace
      if (exception instanceof Error) {
        this.logger.error(`${errorCodePrefix}${method} ${url} - ${exception.message}`, exception.stack);
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
