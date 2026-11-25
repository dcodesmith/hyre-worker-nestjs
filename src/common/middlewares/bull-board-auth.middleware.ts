import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * Fail-closed middleware used when Bull Board credentials are not configured.
 */
export function createBullBoardDisabledMiddleware(): (
  req: Request,
  res: Response,
  next: NextFunction,
) => void {
  return (_req: Request, res: Response) => {
    res.sendStatus(404);
  };
}

/**
 * Creates a basic authentication middleware for Bull Board
 * Uses timing-safe comparison to prevent timing attacks
 */
export function createBullBoardAuthMiddleware(
  username: string,
  password: string,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.get("authorization");

    if (!authHeader?.startsWith("Basic ")) {
      sendUnauthorizedResponse(res);
      return;
    }

    const encoded = authHeader.slice("Basic ".length).trim();
    const decoded = Buffer.from(encoded, "base64").toString("utf-8");
    const separatorIndex = decoded.indexOf(":");

    if (separatorIndex === -1) {
      sendUnauthorizedResponse(res);
      return;
    }

    const reqUsername = decoded.slice(0, separatorIndex);
    const reqPassword = decoded.slice(separatorIndex + 1);

    if (!isValidCredentials(reqUsername, reqPassword, username, password)) {
      sendUnauthorizedResponse(res);
      return;
    }

    next();
  };
}

/**
 * Timing-safe credential validation to prevent timing attacks
 */
function isValidCredentials(
  providedUsername: string,
  providedPassword: string,
  expectedUsername: string,
  expectedPassword: string,
): boolean {
  const validUsername = safeCompare(providedUsername, expectedUsername);
  const validPassword = safeCompare(providedPassword, expectedPassword);
  return validUsername && validPassword;
}

/**
 * Timing-safe string comparison using fixed-length SHA-256 digests so neither
 * length differences nor multi-byte UTF-8 inputs leak timing or throw RangeError.
 */
function safeCompare(provided: string, expected: string): boolean {
  const providedDigest = createHash("sha256").update(provided).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();

  return timingSafeEqual(providedDigest, expectedDigest);
}

/**
 * Sends a 401 Unauthorized response with WWW-Authenticate header
 */
function sendUnauthorizedResponse(res: Response): void {
  res.setHeader("WWW-Authenticate", 'Basic realm="Bull Board", charset="UTF-8"');
  res.sendStatus(401);
}
