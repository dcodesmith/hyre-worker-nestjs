import { BadRequestException, HttpStatus } from "@nestjs/common";
import type { HttpAdapterHost } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";
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
    const filter = new GlobalExceptionFilter(adapterHost);
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
    const filter = new GlobalExceptionFilter(adapterHost);
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
});
