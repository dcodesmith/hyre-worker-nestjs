import { createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_TTL_MS = 30 * 60_000;

function signature(phoneNumber: string, expiresAt: number, secret: string): string {
  return createHmac("sha256", secret)
    .update(`hyre:guest-phone-verification:v1:${phoneNumber}:${expiresAt}`)
    .digest("base64url");
}

export function createGuestPhoneVerificationToken(
  phoneNumber: string,
  secret: string,
  now = Date.now(),
): string {
  const expiresAt = now + TOKEN_TTL_MS;
  return `${expiresAt}.${signature(phoneNumber, expiresAt, secret)}`;
}

export function matchesGuestPhoneVerificationToken(
  token: string | undefined,
  phoneNumber: string,
  secret: string,
  now = Date.now(),
): boolean {
  if (!token) return false;

  const [rawExpiresAt, suppliedSignature, extra] = token.split(".");
  const expiresAt = Number(rawExpiresAt);
  if (extra !== undefined || !Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;

  const supplied = Buffer.from(suppliedSignature ?? "", "base64url");
  const expected = Buffer.from(signature(phoneNumber, expiresAt, secret), "base64url");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
