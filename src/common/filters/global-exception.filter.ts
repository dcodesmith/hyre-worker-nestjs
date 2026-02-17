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
import type { ProblemDetails } from "../errors/problem-details.interface";

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

    const instance = httpAdapter.getRequestUrl(request);
    const problem = this.toProblemDetails(exception, httpStatus, instance);

    this.logError(exception, request, httpStatus, problem.errorCode);
    httpAdapter.reply(ctx.getResponse(), problem, httpStatus);
  }

  private toProblemDetails(
    exception: unknown,
    httpStatus: number,
    instance: string,
  ): ProblemDetails & {
    errorCode?: string;
    errors?: unknown[];
    details?: Record<string, unknown>;
  } {
    if (exception instanceof AppException) {
      return {
        ...exception.getProblemDetails(),
        instance,
      };
    }

    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      const title = this.httpStatusTitle(httpStatus);

      if (this.isProblemDetailsResponse(response)) {
        return {
          ...response,
          status: httpStatus,
          instance,
        };
      }

      if (typeof response === "object" && response !== null) {
        const mapped = response as {
          message?: unknown;
          error?: unknown;
          errors?: unknown[];
          details?: Record<string, unknown>;
          errorCode?: string;
        };
        const detail = this.extractDetail(mapped.message, mapped.error);

        return {
          type: mapped.errorCode ?? title,
          title,
          status: httpStatus,
          detail,
          instance,
          ...(mapped.errorCode && { errorCode: mapped.errorCode }),
          ...(mapped.errors && { errors: mapped.errors }),
          ...(mapped.details && { details: mapped.details }),
        };
      }

      return {
        type: title,
        title,
        status: httpStatus,
        detail: typeof response === "string" ? response : "HTTP error occurred",
        instance,
      };
    }

    return {
      type: "INTERNAL_SERVER_ERROR",
      title: "Internal Server Error",
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      detail: exception instanceof Error ? exception.message : "Internal server error",
      instance,
    };
  }

  private isProblemDetailsResponse(response: unknown): response is ProblemDetails & {
    errorCode?: string;
    errors?: unknown[];
    details?: Record<string, unknown>;
  } {
    if (typeof response !== "object" || response === null) {
      return false;
    }

    return (
      "type" in response &&
      typeof response.type === "string" &&
      "title" in response &&
      typeof response.title === "string" &&
      "status" in response &&
      typeof response.status === "number" &&
      "detail" in response &&
      typeof response.detail === "string"
    );
  }

  private extractDetail(message?: unknown, error?: unknown): string {
    if (typeof message === "string") {
      return message;
    }
    if (Array.isArray(message)) {
      return message
        .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
        .join(", ");
    }
    if (message !== undefined) {
      return String(message);
    }
    if (typeof error === "string") {
      return error;
    }

    return "Request failed";
  }

  private httpStatusTitle(httpStatus: number): string {
    return HttpStatus[httpStatus] ?? "HTTP Error";
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
