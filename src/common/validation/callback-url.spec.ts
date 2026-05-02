import { describe, expect, it } from "vitest";
import { isAllowedCallbackUrl } from "./callback-url";

describe("isAllowedCallbackUrl", () => {
  it("allows https callback URLs in production", () => {
    expect(isAllowedCallbackUrl("https://app.example.com/payment/callback", "production")).toBe(
      true,
    );
  });

  it("rejects http callback URLs in production", () => {
    expect(isAllowedCallbackUrl("http://localhost:3000/payment/callback", "production")).toBe(
      false,
    );
  });

  it("allows http callback URLs in non-production", () => {
    expect(isAllowedCallbackUrl("http://localhost:3000/payment/callback", "development")).toBe(
      true,
    );
    expect(isAllowedCallbackUrl("http://127.0.0.1:3000/payment/callback", "test")).toBe(true);
  });

  it("rejects unsafe protocols", () => {
    expect(isAllowedCallbackUrl("javascript:alert(1)", "development")).toBe(false);
    expect(isAllowedCallbackUrl("data:text/html,hi", "development")).toBe(false);
    expect(isAllowedCallbackUrl("file:///etc/passwd", "development")).toBe(false);
  });

  it("allows mobile deep-link callback URLs", () => {
    expect(isAllowedCallbackUrl("hyreapp://payments/complete?tx=abc123", "production")).toBe(true);
  });
});
