import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { REQUEST_ID_HEADER, RequestIdMiddleware } from "./request-id.middleware";

describe("RequestIdMiddleware", () => {
  let middleware: RequestIdMiddleware;
  let req: Request;
  let res: Response;
  let next: NextFunction;

  let getHeader: ReturnType<typeof vi.fn>;
  let setHeader: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    middleware = new RequestIdMiddleware();
    getHeader = vi.fn();
    setHeader = vi.fn();
    next = vi.fn();

    req = {
      get: getHeader,
      headers: {},
    } as unknown as Request;

    res = {
      setHeader,
    } as unknown as Response;
  });

  it("should generate a new request ID when none is provided", () => {
    getHeader.mockReturnValue(undefined);

    middleware.use(req, res, next);

    expect(req.headers[REQUEST_ID_HEADER]).toBeDefined();
    expect(typeof req.headers[REQUEST_ID_HEADER]).toBe("string");
    expect(req.headers[REQUEST_ID_HEADER]).toHaveLength(36); // UUID v4 length
    expect(setHeader).toHaveBeenCalledWith(REQUEST_ID_HEADER, req.headers[REQUEST_ID_HEADER]);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("should preserve an existing request ID from the header", () => {
    const existingId = "existing-request-id-123";
    getHeader.mockReturnValue(existingId);

    middleware.use(req, res, next);

    expect(req.headers[REQUEST_ID_HEADER]).toBe(existingId);
    expect(setHeader).toHaveBeenCalledWith(REQUEST_ID_HEADER, existingId);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("should set the request ID on the response header", () => {
    getHeader.mockReturnValue(undefined);

    middleware.use(req, res, next);

    expect(setHeader).toHaveBeenCalledWith(REQUEST_ID_HEADER, expect.any(String));
  });
});
