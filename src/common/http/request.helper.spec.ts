import { afterEach, describe, expect, it, vi } from "vitest";
import { getRequestOrigin } from "./request.helper";

describe("getRequestOrigin", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns AUTH_BASE_URL when configured", () => {
    vi.stubEnv("AUTH_BASE_URL", "https://auth.example.com");
    vi.stubEnv("TRUSTED_ORIGINS", "https://app.example.com");

    const request = {
      headers: { "x-forwarded-proto": "http" },
      protocol: "http",
      get: vi.fn().mockReturnValue("evil.example.com"),
      app: { get: vi.fn().mockReturnValue(false) },
    };

    expect(getRequestOrigin(request)).toBe("https://auth.example.com");
  });

  it("falls back to first TRUSTED_ORIGINS when AUTH_BASE_URL is absent", () => {
    vi.stubEnv("AUTH_BASE_URL", "");
    vi.stubEnv("TRUSTED_ORIGINS", "https://app.example.com,https://admin.example.com");

    const request = {
      headers: {},
      protocol: "http",
      get: vi.fn().mockReturnValue("localhost:3000"),
      app: { get: vi.fn().mockReturnValue(false) },
    };

    expect(getRequestOrigin(request)).toBe("https://app.example.com");
  });

  it("uses forwarded proto only when trust proxy is enabled", () => {
    vi.stubEnv("AUTH_BASE_URL", "");
    vi.stubEnv("TRUSTED_ORIGINS", "https://api.example.com");

    const request = {
      headers: { "x-forwarded-proto": "https" },
      protocol: "http",
      get: vi.fn().mockReturnValue("api.example.com"),
      app: {
        get: vi
          .fn()
          .mockImplementation((key: string) => (key === "trust proxy" ? true : undefined)),
      },
    };

    expect(getRequestOrigin(request)).toBe("https://api.example.com");
  });

  it("ignores forwarded proto when trust proxy is disabled", () => {
    vi.stubEnv("AUTH_BASE_URL", "");
    vi.stubEnv("TRUSTED_ORIGINS", "");

    const request = {
      headers: { "x-forwarded-proto": "https" },
      protocol: "http",
      get: vi.fn().mockReturnValue("localhost:3000"),
      app: { get: vi.fn().mockReturnValue(false) },
    };

    expect(getRequestOrigin(request)).toBe("http://localhost:3000");
  });

  it("returns null for untrusted host when no configured origin is present", () => {
    vi.stubEnv("AUTH_BASE_URL", "");
    vi.stubEnv("TRUSTED_ORIGINS", "");

    const request = {
      headers: {},
      protocol: "https",
      get: vi.fn().mockReturnValue("evil.example.com"),
      app: { get: vi.fn().mockReturnValue(false) },
    };

    expect(getRequestOrigin(request)).toBeNull();
  });
});
