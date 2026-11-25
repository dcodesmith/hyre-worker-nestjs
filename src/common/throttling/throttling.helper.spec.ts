import type { ThrottlerStorage } from "@nestjs/throttler";
import { describe, expect, it, vi } from "vitest";
import {
  enforceNamedIpThrottle,
  getClientIp,
  getRetryAfterSeconds,
  type ThrottleHitRecord,
} from "./throttling.helper";

function createMemoryStorage(): ThrottlerStorage {
  const hits = new Map<string, number>();

  return {
    increment: vi.fn(async (key: string, _ttl: number, limit: number) => {
      const totalHits = (hits.get(key) ?? 0) + 1;
      hits.set(key, totalHits);
      const isBlocked = totalHits > limit;

      return {
        totalHits,
        timeToExpire: 60_000,
        isBlocked,
        timeToBlockExpire: isBlocked ? 60_000 : 0,
      };
    }),
  };
}

describe("getRetryAfterSeconds", () => {
  it("converts timeToBlockExpire from milliseconds to seconds", () => {
    const hit = { timeToBlockExpire: 3_600_000 } as unknown as ThrottleHitRecord;

    expect(getRetryAfterSeconds(hit, 60)).toBe(3600);
  });

  it("falls back to timeToExpire when timeToBlockExpire is missing", () => {
    const hit = { timeToExpire: 1250 } as unknown as ThrottleHitRecord;

    expect(getRetryAfterSeconds(hit, 60)).toBe(2);
  });

  it("uses fallback seconds when throttler values are unavailable", () => {
    const hit = {} as unknown as ThrottleHitRecord;

    expect(getRetryAfterSeconds(hit, 3600)).toBe(3600);
  });

  it("returns at least one second", () => {
    const hit = { timeToExpire: 0 } as unknown as ThrottleHitRecord;

    expect(getRetryAfterSeconds(hit, 0)).toBe(1);
  });
});

describe("getClientIp", () => {
  it("ignores spoofed x-forwarded-for, x-real-ip, and unauthenticated cf-connecting-ip", () => {
    expect(
      getClientIp({
        ip: "10.0.0.1",
        headers: {
          "x-forwarded-for": "198.51.100.99",
          "x-real-ip": "198.51.100.98",
          "cf-connecting-ip": "198.51.100.97",
          "fly-client-ip": "203.0.113.10",
        },
      }),
    ).toBe("203.0.113.10");
  });

  it("trusts cf-connecting-ip only when x-hyre-edge matches EDGE_CLIENT_SECRET", () => {
    const secret = "edge-secret-12345678";
    expect(
      getClientIp(
        {
          ip: "10.0.0.1",
          headers: {
            "x-hyre-edge": secret,
            "cf-connecting-ip": "198.51.100.42",
            "fly-client-ip": "203.0.113.10",
          },
        },
        secret,
      ),
    ).toBe("198.51.100.42");
  });

  it("falls back to request.ip when no trusted edge header is present", () => {
    expect(
      getClientIp({
        ip: "203.0.113.55",
        headers: { "x-forwarded-for": "198.51.100.1" },
      }),
    ).toBe("203.0.113.55");
  });
});

describe("enforceNamedIpThrottle", () => {
  const config = {
    name: "test-public",
    ttlMs: 60_000,
    ttlSeconds: 60,
    limit: 2,
  };

  it("allows requests under the limit", async () => {
    const storage = createMemoryStorage();
    const response = { setHeader: vi.fn() };

    await expect(
      enforceNamedIpThrottle({
        request: { headers: { "fly-client-ip": "203.0.113.10" }, method: "GET" },
        response,
        storage,
        config,
        fallbackPath: "search-flight",
        createException: () => new Error("limited"),
      }),
    ).resolves.toBe(true);
  });

  it("blocks one IP without blocking another and ignores spoofed x-forwarded-for rotation", async () => {
    const storage = createMemoryStorage();
    const response = { setHeader: vi.fn() };
    const input = {
      response,
      storage,
      config,
      fallbackPath: "search-flight",
      createException: () => new Error("limited"),
    };

    await enforceNamedIpThrottle({
      ...input,
      request: {
        headers: { "fly-client-ip": "203.0.113.10", "x-forwarded-for": "1.1.1.1" },
        method: "GET",
      },
    });
    await enforceNamedIpThrottle({
      ...input,
      request: {
        headers: { "fly-client-ip": "203.0.113.10", "x-forwarded-for": "2.2.2.2" },
        method: "GET",
      },
    });

    await expect(
      enforceNamedIpThrottle({
        ...input,
        request: {
          headers: { "fly-client-ip": "203.0.113.10", "x-forwarded-for": "3.3.3.3" },
          method: "GET",
        },
      }),
    ).rejects.toThrow("limited");

    await expect(
      enforceNamedIpThrottle({
        ...input,
        request: { headers: { "fly-client-ip": "198.51.100.20" }, method: "GET" },
      }),
    ).resolves.toBe(true);
  });
});
