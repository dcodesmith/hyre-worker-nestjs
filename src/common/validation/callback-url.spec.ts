import { describe, expect, it } from "vitest";
import { callbackUrlSchema, isAllowedCallbackUrl } from "./callback-url";

const prodEnv = {
  APP_ENV: "production",
  TRUSTED_ORIGINS: "https://app.example.com, https://admin.example.com, hyreapp://",
  WEBSITE_URL: "https://tripdly.com",
};

const devFlyEnv = {
  APP_ENV: "development",
  TRUSTED_ORIGINS: "https://hyre-worker-nestjs.fly.dev",
  WEBSITE_URL: "https://hyre-web-development.tripdly.workers.dev",
  LOCAL_WEB_ORIGINS: "http://localhost:5173,http://127.0.0.1:5173",
};

describe("isAllowedCallbackUrl", () => {
  it("allows https callback URLs matching TRUSTED_ORIGINS or WEBSITE_URL in production", () => {
    expect(
      isAllowedCallbackUrl("https://app.example.com/payment/callback", "production", prodEnv),
    ).toBe(true);
    expect(
      isAllowedCallbackUrl("https://tripdly.com/payment/callback", "production", prodEnv),
    ).toBe(true);
  });

  it("rejects untrusted https origins in production and non-production", () => {
    expect(isAllowedCallbackUrl("https://evil.example/phish", "production", prodEnv)).toBe(false);
    expect(isAllowedCallbackUrl("https://evil.example/phish", "development", prodEnv)).toBe(false);
    expect(isAllowedCallbackUrl("https://app.example.com/callback", "production", {})).toBe(false);
  });

  it("rejects callback URLs containing embedded credentials", () => {
    expect(
      isAllowedCallbackUrl("https://user:pass@app.example.com/callback", "production", prodEnv),
    ).toBe(false);
  });

  it("rejects http callback URLs in production", () => {
    expect(
      isAllowedCallbackUrl("http://localhost:3000/payment/callback", "production", prodEnv),
    ).toBe(false);
  });

  it("allows localhost http callback URLs in non-production", () => {
    expect(
      isAllowedCallbackUrl("http://localhost:3000/payment/callback", "development", prodEnv),
    ).toBe(true);
    expect(isAllowedCallbackUrl("http://127.0.0.1:3000/payment/callback", "test", {})).toBe(true);
  });

  it("rejects unsafe protocols and unallowlisted custom schemes", () => {
    expect(isAllowedCallbackUrl("javascript:alert(1)", "development", prodEnv)).toBe(false);
    expect(isAllowedCallbackUrl("data:text/html,hi", "development", prodEnv)).toBe(false);
    expect(isAllowedCallbackUrl("file:///etc/passwd", "development", prodEnv)).toBe(false);
    expect(isAllowedCallbackUrl("evilscheme://steal?token=1", "production", prodEnv)).toBe(false);
  });

  it("allows configured mobile deep-link callback URLs", () => {
    expect(
      isAllowedCallbackUrl(
        "hyremobile://payment-status?transactionType=booking_creation",
        "production",
        prodEnv,
      ),
    ).toBe(true);
    expect(
      isAllowedCallbackUrl(
        "hyremobile:///payment-status?transactionType=booking_creation",
        "production",
        prodEnv,
      ),
    ).toBe(true);
    expect(
      isAllowedCallbackUrl("hyremobile://extension-payment-status", "production", prodEnv),
    ).toBe(true);
    expect(
      isAllowedCallbackUrl("hyremobile:///extension-payment-status", "production", prodEnv),
    ).toBe(true);
    expect(
      isAllowedCallbackUrl("hyreapp://payments/complete?tx=abc123", "production", prodEnv),
    ).toBe(true);
    expect(
      isAllowedCallbackUrl("tripdly://payments/complete?tx=abc123", "production", prodEnv),
    ).toBe(true);
  });

  it("allows Expo dev scheme and LOCAL_WEB_ORIGINS on development APIs only", () => {
    expect(
      isAllowedCallbackUrl("exp://192.168.1.10:8081/--/payment-status", "production", devFlyEnv),
    ).toBe(true);
    expect(
      isAllowedCallbackUrl("exp://192.168.1.10:8081/--/payment-status", "production", prodEnv),
    ).toBe(false);
    expect(
      isAllowedCallbackUrl(
        "http://localhost:5173/bookings/payment-status",
        "production",
        devFlyEnv,
      ),
    ).toBe(true);
    expect(
      isAllowedCallbackUrl(
        "http://localhost:3000/bookings/payment-status",
        "production",
        devFlyEnv,
      ),
    ).toBe(false);
    expect(
      isAllowedCallbackUrl("http://localhost:5173/bookings/payment-status", "production", prodEnv),
    ).toBe(false);
  });

  it("accepts mobile booking and extension callback URLs through callbackUrlSchema", () => {
    expect(
      callbackUrlSchema.safeParse("hyremobile://payment-status?transactionType=booking_creation")
        .success,
    ).toBe(true);
    expect(
      callbackUrlSchema.safeParse("hyremobile:///payment-status?transactionType=booking_creation")
        .success,
    ).toBe(true);
    expect(callbackUrlSchema.safeParse("hyremobile://extension-payment-status").success).toBe(true);
    expect(callbackUrlSchema.safeParse("hyremobile:///extension-payment-status").success).toBe(
      true,
    );
  });
});
