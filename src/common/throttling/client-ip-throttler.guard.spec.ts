import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { ThrottlerStorage } from "@nestjs/throttler";
import { describe, expect, it, vi } from "vitest";
import { ClientIpThrottlerGuard } from "./client-ip-throttler.guard";

class TestableClientIpThrottlerGuard extends ClientIpThrottlerGuard {
  resolveTracker(req: Record<string, unknown>): Promise<string> {
    return this.getTracker(req);
  }
}

describe("ClientIpThrottlerGuard", () => {
  it("tracks by verified cf-connecting-ip when edge secret matches and ignores spoofed headers", async () => {
    const secret = "edge-secret-12345678";
    const module = await Test.createTestingModule({
      providers: [
        TestableClientIpThrottlerGuard,
        {
          provide: "THROTTLER:MODULE_OPTIONS",
          useValue: [{ name: "default", ttl: 60_000, limit: 10 }],
        },
        { provide: ThrottlerStorage, useValue: { increment: vi.fn(), get: vi.fn() } },
        Reflector,
        {
          provide: ConfigService,
          useValue: { get: vi.fn(() => secret) },
        },
      ],
    }).compile();

    const guard = module.get(TestableClientIpThrottlerGuard);

    await expect(
      guard.resolveTracker({
        ip: "10.0.0.2",
        headers: {
          "x-hyre-edge": secret,
          "cf-connecting-ip": "198.51.100.7",
          "x-forwarded-for": "1.2.3.4",
        },
      }),
    ).resolves.toBe("198.51.100.7");

    await expect(
      guard.resolveTracker({
        ip: "10.0.0.2",
        headers: {
          "x-forwarded-for": "1.2.3.4",
          "cf-connecting-ip": "5.6.7.8",
          "fly-client-ip": "203.0.113.9",
        },
      }),
    ).resolves.toBe("203.0.113.9");
  });
});
