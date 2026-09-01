import { BadRequestException, HttpStatus } from "@nestjs/common";
import type { HttpAdapterHost } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";
import { createMockPinoLogger } from "@/testing/nest-pino-logger.mock";
import { AppException } from "../errors/app.exception";
import { GlobalExceptionFilter } from "./global-exception.filter";

function createHostMocks() {
  const reply = vi.fn();
  const getRequestUrl = vi.fn().mockReturnValue("/api/test");
  const response = {};
  const request = { url: "/api/test", method: "GET" };
  const ctx = {
    getRequest: () => request,
    getResponse: () => response,
  };
  const host = {
    switchToHttp: () => ctx,
  };

  return {
    reply,
    getRequestUrl,
    response,
    host,
  };
}

describe("GlobalExceptionFilter", () => {
  it("returns RFC7807 payload for AppException", () => {
    const { reply, getRequestUrl, response, host } = createHostMocks();
    const adapterHost = {
      httpAdapter: {
        reply,
        getRequestUrl,
      },
    } as unknown as HttpAdapterHost;
    const filter = new GlobalExceptionFilter(adapterHost, createMockPinoLogger());
    const exception = new AppException(
      "REVIEW_NOT_FOUND",
      "Review not found",
      HttpStatus.NOT_FOUND,
      { title: "Review Not Found" },
    );

    filter.catch(exception, host as unknown as Parameters<GlobalExceptionFilter["catch"]>[1]);

    expect(reply).toHaveBeenCalledWith(
      response,
      expect.objectContaining({
        type: "REVIEW_NOT_FOUND",
        title: "Review Not Found",
        status: HttpStatus.NOT_FOUND,
        detail: "Review not found",
        instance: "/api/test",
        errorCode: "REVIEW_NOT_FOUND",
      }),
      HttpStatus.NOT_FOUND,
    );
  });

  it("normalizes non-problem BadRequestException to RFC7807", () => {
    const { reply, getRequestUrl, response, host } = createHostMocks();
    const adapterHost = {
      httpAdapter: {
        reply,
        getRequestUrl,
      },
    } as unknown as HttpAdapterHost;
    const filter = new GlobalExceptionFilter(adapterHost, createMockPinoLogger());
    const exception = new BadRequestException({
      message: "Validation failed",
      errors: [{ field: "email", message: "Invalid email" }],
    });

    filter.catch(exception, host as unknown as Parameters<GlobalExceptionFilter["catch"]>[1]);

    expect(reply).toHaveBeenCalledWith(
      response,
      expect.objectContaining({
        type: "BAD_REQUEST",
        title: "BAD_REQUEST",
        status: HttpStatus.BAD_REQUEST,
        detail: "Validation failed",
        instance: "/api/test",
        errors: [{ field: "email", message: "Invalid email" }],
      }),
      HttpStatus.BAD_REQUEST,
    );
  });

  it("preserves explicit detail/type/title from HttpException response object", () => {
    const { reply, getRequestUrl, response, host } = createHostMocks();
    const adapterHost = {
      httpAdapter: {
        reply,
        getRequestUrl,
      },
    } as unknown as HttpAdapterHost;
    const filter = new GlobalExceptionFilter(adapterHost, createMockPinoLogger());
    const exception = new BadRequestException({
      type: "CUSTOM_TYPE",
      title: "Custom Title",
      detail: "Custom detail",
      message: "Fallback message",
      errorCode: "VALIDATION_ERROR",
      errors: [{ field: "email", message: "Invalid email" }],
      details: { source: "validation" },
    });

    filter.catch(exception, host as unknown as Parameters<GlobalExceptionFilter["catch"]>[1]);

    expect(reply).toHaveBeenCalledWith(
      response,
      expect.objectContaining({
        type: "CUSTOM_TYPE",
        title: "Custom Title",
        status: HttpStatus.BAD_REQUEST,
        detail: "Custom detail",
        instance: "/api/test",
        errorCode: "VALIDATION_ERROR",
        errors: [{ field: "email", message: "Invalid email" }],
        details: { source: "validation" },
      }),
      HttpStatus.BAD_REQUEST,
    );
  });

  it("does not expose unexpected Error messages in 500 responses", () => {
    const { reply, getRequestUrl, response, host } = createHostMocks();
    const logger = createMockPinoLogger();
    const adapterHost = {
      httpAdapter: {
        reply,
        getRequestUrl,
      },
    } as unknown as HttpAdapterHost;
    const filter = new GlobalExceptionFilter(adapterHost, logger);
    const exception = new Error("database password was rejected");

    filter.catch(exception, host as unknown as Parameters<GlobalExceptionFilter["catch"]>[1]);

    expect(reply).toHaveBeenCalledWith(
      response,
      expect.objectContaining({
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        detail: "Internal server error",
      }),
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: exception,
        method: "GET",
        url: "/api/test",
        httpStatus: HttpStatus.INTERNAL_SERVER_ERROR,
      }),
      "HTTP request failed",
    );
  });

  it("omits internal details from server-side AppException responses", () => {
    const { reply, getRequestUrl, response, host } = createHostMocks();
    const adapterHost = {
      httpAdapter: {
        reply,
        getRequestUrl,
      },
    } as unknown as HttpAdapterHost;
    const filter = new GlobalExceptionFilter(adapterHost, createMockPinoLogger());
    const exception = new AppException(
      "PROVIDER_FAILED",
      "Provider unavailable",
      HttpStatus.BAD_GATEWAY,
      {
        details: { providerToken: "secret" },
      },
    );

    filter.catch(exception, host as unknown as Parameters<GlobalExceptionFilter["catch"]>[1]);

    expect(reply).toHaveBeenCalledWith(
      response,
      expect.not.objectContaining({
        details: expect.anything(),
      }),
      HttpStatus.BAD_GATEWAY,
    );
  });

  it("uses a safe fallback for non-string HttpException messages", () => {
    const { reply, getRequestUrl, response, host } = createHostMocks();
    const adapterHost = {
      httpAdapter: {
        reply,
        getRequestUrl,
      },
    } as unknown as HttpAdapterHost;
    const filter = new GlobalExceptionFilter(adapterHost, createMockPinoLogger());
    const exception = new BadRequestException({
      message: [{ token: "must not be exposed" }, null],
    });

    filter.catch(exception, host as unknown as Parameters<GlobalExceptionFilter["catch"]>[1]);

    expect(reply).toHaveBeenCalledWith(
      response,
      expect.objectContaining({
        status: HttpStatus.BAD_REQUEST,
        detail: "Request failed",
      }),
      HttpStatus.BAD_REQUEST,
    );
  });
});
