import { createHmac, timingSafeEqual } from "node:crypto";

export function createHmacSignature(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

/**
 * Performs timing-safe string comparison by hashing both values first.
 * This avoids length-based timing leaks when comparing secrets.
 */
export function timingSafeSecretMatch(
  receivedSecret: string,
  expectedSecret: string,
  hmacKey: string,
): boolean {
  const receivedHash = createHmac("sha256", hmacKey).update(receivedSecret).digest();
  const expectedHash = createHmac("sha256", hmacKey).update(expectedSecret).digest();
  return timingSafeEqual(receivedHash, expectedHash);
}
