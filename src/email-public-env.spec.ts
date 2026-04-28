import { afterEach, describe, expect, it, vi } from "vitest";
import { getEmailPublicEnv } from "./email-public-env";

describe("getEmailPublicEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("maps env vars for email rendering", () => {
    vi.stubEnv("APP_NAME", "TestApp");
    vi.stubEnv("DOMAIN", "https://example.com");
    vi.stubEnv("WEBSITE_URL", "https://app.example.com");
    vi.stubEnv("SUPPORT_EMAIL", "help@example.com");
    vi.stubEnv("COMPANY_ADDRESS", "Abuja, Nigeria");

    const env = getEmailPublicEnv();

    expect(env.appName).toBe("TestApp");
    expect(env.domain).toBe("https://example.com");
    expect(env.websiteUrl).toBe("https://app.example.com");
    expect(env.supportEmail).toBe("help@example.com");
    expect(env.companyAddress).toBe("Abuja, Nigeria");
  });

  it("falls back WEBSITE_URL to DOMAIN when WEBSITE_URL is unset", () => {
    vi.stubEnv("DOMAIN", "https://fallback.example");
    delete process.env.WEBSITE_URL;

    expect(getEmailPublicEnv().websiteUrl).toBe("https://fallback.example");
  });
});
