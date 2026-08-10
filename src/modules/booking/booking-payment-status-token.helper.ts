import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function hashBookingPaymentStatusToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createBookingPaymentStatusToken(
  bookingId: string,
  secret: string,
): {
  token: string;
  tokenHash: string;
} {
  const token = createHmac("sha256", secret)
    .update(`hyre:booking-payment-status:v1:${bookingId}`)
    .digest("base64url");
  return { token, tokenHash: hashBookingPaymentStatusToken(token) };
}

export function matchesBookingPaymentStatusToken(
  token: string | undefined,
  expectedHash: string | null,
): boolean {
  if (!token || !expectedHash) return false;

  const actual = Buffer.from(hashBookingPaymentStatusToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
