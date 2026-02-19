import { describe, expect, it } from "vitest";
import { timingSafeSecretMatch } from "./webhook-signature.helper";

describe("timingSafeSecretMatch", () => {
  const hmacKey = "test-hmac-key";

  it("returns true for matching secrets", () => {
    expect(timingSafeSecretMatch("secret-123", "secret-123", hmacKey)).toBe(true);
  });

  it("returns false for different secrets", () => {
    expect(timingSafeSecretMatch("secret-123", "wrong-secret", hmacKey)).toBe(false);
  });

  it("returns false for different-length secrets", () => {
    expect(timingSafeSecretMatch("short", "a-much-longer-secret-value", hmacKey)).toBe(false);
  });
});
