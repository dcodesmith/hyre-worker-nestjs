import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

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

    const encoded = authHeader.split(" ")[1];
    const decoded = Buffer.from(encoded, "base64").toString("utf-8");
    const [reqUsername, reqPassword] = decoded.split(":");

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
 * Timing-safe string comparison
 */
function safeCompare(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) {
    return false;
  }

  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);

  return timingSafeEqual(providedBuffer, expectedBuffer);
}

/**
 * Sends a 401 Unauthorized response with WWW-Authenticate header
 */
function sendUnauthorizedResponse(res: Response): void {
  res.setHeader("WWW-Authenticate", 'Basic realm="Bull Board", charset="UTF-8"');
  res.sendStatus(401);
}
