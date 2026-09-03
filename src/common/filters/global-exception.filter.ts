import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
} from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { PinoLogger } from "nestjs-pino";
import { AppException } from "../errors/app.exception";
import type { ProblemDetails } from "../errors/problem-details.interface";
import { stripQueryString } from "../http/request-url.helper";
import { getErrorMessage, toLogError } from "../logging/error-logging.helper";

type ExceptionLogger = Pick<PinoLogger, "setContext" | "error" | "warn">;

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
  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    @Inject(PinoLogger) private readonly logger: ExceptionLogger,
  ) {
    this.logger.setContext(GlobalExceptionFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    // Get HTTP adapter for platform-agnostic response handling
    const { httpAdapter } = this.httpAdapterHost;

    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();

    // Determine HTTP status code
    const httpStatus =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    const instance = stripQueryString(httpAdapter.getRequestUrl(request)) ?? "unknown";
    const problem = this.withoutServerErrorDetails(
      this.toProblemDetails(exception, httpStatus, instance),
      httpStatus,
    );

    this.logError(exception, request, httpStatus, problem.errorCode);
    httpAdapter.reply(ctx.getResponse(), problem, httpStatus);
  }

  private withoutServerErrorDetails(
    problem: ProblemDetails & {
      errorCode?: string;
      errors?: unknown[];
      details?: Record<string, unknown>;
    },
    httpStatus: number,
  ): ProblemDetails & { errorCode?: string } {
    if (httpStatus < 500) {
      return problem;
    }

    return {
      type: problem.type,
      title: problem.title,
      status: problem.status,
      detail: "Internal server error",
      ...(problem.instance && { instance: problem.instance }),
      ...(problem.errorCode && { errorCode: problem.errorCode }),
    };
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
      return this.toHttpExceptionProblemDetails(exception, httpStatus, instance);
    }

    return {
      type: "INTERNAL_SERVER_ERROR",
      title: "Internal Server Error",
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      detail: "Internal server error",
      instance,
    };
  }

  private toHttpExceptionProblemDetails(
    exception: HttpException,
    httpStatus: number,
    instance: string,
  ): ProblemDetails & {
    errorCode?: string;
    errors?: unknown[];
    details?: Record<string, unknown>;
  } {
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
      return this.mapHttpObjectResponse(response, httpStatus, instance, title);
    }

    return {
      type: title,
      title,
      status: httpStatus,
      detail: typeof response === "string" ? response : "HTTP error occurred",
      instance,
    };
  }

  private mapHttpObjectResponse(
    response: object,
    httpStatus: number,
    instance: string,
    title: string,
  ): ProblemDetails & {
    errorCode?: string;
    errors?: unknown[];
    details?: Record<string, unknown>;
  } {
    const mapped = response as {
      detail?: unknown;
      type?: unknown;
      title?: unknown;
      message?: unknown;
      error?: unknown;
      errors?: unknown[];
      details?: Record<string, unknown>;
      errorCode?: string;
    };

    return {
      type:
        (typeof mapped.type === "string" ? mapped.type : undefined) ?? mapped.errorCode ?? title,
      title: (typeof mapped.title === "string" ? mapped.title : undefined) ?? title,
      status: httpStatus,
      detail:
        (typeof mapped.detail === "string" ? mapped.detail : undefined) ??
        this.extractDetail(mapped.message, mapped.error),
      instance,
      ...(mapped.errorCode && { errorCode: mapped.errorCode }),
      ...(httpStatus < 500 && mapped.errors && { errors: mapped.errors }),
      ...(httpStatus < 500 && mapped.details && { details: mapped.details }),
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
      const messages = message.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      );
      return messages.length > 0 ? messages.join(", ") : "Request failed";
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
    const url = stripQueryString(request.url) || "unknown";
    const method = request.method || "unknown";

    // Include error code in log message if present
    const errorCodePrefix = errorCode ? `[${errorCode}] ` : "";

    if (httpStatus >= 500) {
      const error = toLogError(exception);
      this.logger.error(
        {
          err: error,
          method,
          url,
          httpStatus,
          ...(errorCode && { errorCode }),
        },
        `${errorCodePrefix}HTTP request failed`,
      );
    } else if (httpStatus >= 400) {
      const error = getErrorMessage(exception);
      this.logger.warn(
        {
          method,
          url,
          httpStatus,
          error,
          ...(errorCode && { errorCode }),
        },
        `${errorCodePrefix}HTTP request rejected`,
      );
    }
  }
}
