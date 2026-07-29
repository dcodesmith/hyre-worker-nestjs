import { describe, expect, it } from "vitest";
import { createHmacSignature, timingSafeSecretMatch } from "./webhook-signature.helper";

describe("createHmacSignature", () => {
  it("scopes signatures to their value", () => {
    expect(createHmacSignature("flight-1", "secret")).not.toBe(
      createHmacSignature("flight-2", "secret"),
    );
  });
});

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
