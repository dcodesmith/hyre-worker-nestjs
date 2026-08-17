import { createHash, createHmac } from "node:crypto";

export function hashBookingCompletionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createBookingCompletionToken(
  bookingId: string,
  expiresAt: Date,
  secret = process.env.SESSION_SECRET,
): { token: string; tokenHash: string } {
  if (!secret) {
    throw new Error("SESSION_SECRET is required to create a booking completion token");
  }

  const token = createHmac("sha256", secret)
    .update(`${bookingId}:${expiresAt.toISOString()}`)
    .digest("base64url");
  return { token, tokenHash: hashBookingCompletionToken(token) };
}
