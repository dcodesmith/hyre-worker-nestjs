import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBullBoardAuthMiddleware } from "./bull-board-auth.middleware";

describe("createBullBoardAuthMiddleware", () => {
  const username = "admin";
  const password = "secret";

  let req: Request;
  let res: Response;
  let next: NextFunction;

  let getHeader: ReturnType<typeof vi.fn>;
  let setHeader: ReturnType<typeof vi.fn>;
  let sendStatus: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getHeader = vi.fn();
    setHeader = vi.fn();
    sendStatus = vi.fn();
    next = vi.fn();

    req = { get: getHeader } as unknown as Request;
    res = {
      setHeader,
      sendStatus,
    } as unknown as Response;
  });

  it("should reject when authorization header is missing", () => {
    getHeader.mockReturnValue(undefined);
    const middleware = createBullBoardAuthMiddleware(username, password);

    middleware(req, res, next);

    expect(setHeader).toHaveBeenCalledWith(
      "WWW-Authenticate",
      'Basic realm="Bull Board", charset="UTF-8"',
    );
    expect(sendStatus).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("should reject when authorization header is not Basic", () => {
    getHeader.mockReturnValue("Bearer token");
    const middleware = createBullBoardAuthMiddleware(username, password);

    middleware(req, res, next);

    expect(sendStatus).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("should reject invalid credentials", () => {
    const encoded = Buffer.from("admin:wrong").toString("base64");
    getHeader.mockReturnValue(`Basic ${encoded}`);
    const middleware = createBullBoardAuthMiddleware(username, password);

    middleware(req, res, next);

    expect(sendStatus).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("should allow valid credentials", () => {
    const encoded = Buffer.from("admin:secret").toString("base64");
    getHeader.mockReturnValue(`Basic ${encoded}`);
    const middleware = createBullBoardAuthMiddleware(username, password);

    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(sendStatus).not.toHaveBeenCalled();
  });
});
