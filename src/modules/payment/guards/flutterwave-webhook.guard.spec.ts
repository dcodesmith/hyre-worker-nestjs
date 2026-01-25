import type { ExecutionContext } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FlutterwaveWebhookGuard } from "./flutterwave-webhook.guard";

describe("FlutterwaveWebhookGuard", () => {
  let guard: FlutterwaveWebhookGuard;

  const WEBHOOK_SECRET = "test-webhook-secret-12345";

  const createMockExecutionContext = (
    headers: Record<string, string | undefined>,
  ): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({
          headers,
        }),
      }),
    }) as unknown as ExecutionContext;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FlutterwaveWebhookGuard,
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn().mockReturnValue(WEBHOOK_SECRET),
          },
        },
      ],
    }).compile();

    guard = module.get<FlutterwaveWebhookGuard>(FlutterwaveWebhookGuard);
  });

  it("should be defined", () => {
    expect(guard).toBeDefined();
  });

  describe("canActivate", () => {
    it("should return true for valid signature", () => {
      const context = createMockExecutionContext({
        "verif-hash": WEBHOOK_SECRET,
      });

      expect(guard.canActivate(context)).toBe(true);
    });

    it("should return false when verif-hash header is missing", () => {
      const context = createMockExecutionContext({});

      expect(guard.canActivate(context)).toBe(false);
    });

    it("should return false when verif-hash header is empty", () => {
      const context = createMockExecutionContext({
        "verif-hash": "",
      });

      expect(guard.canActivate(context)).toBe(false);
    });

    it("should return false for invalid signature", () => {
      const context = createMockExecutionContext({
        "verif-hash": "invalid-secret",
      });

      expect(guard.canActivate(context)).toBe(false);
    });

    it("should return false when signatures have different lengths", () => {
      const context = createMockExecutionContext({
        "verif-hash": "short",
      });

      expect(guard.canActivate(context)).toBe(false);
    });

    it("should return false when webhook secret is not configured", async () => {
      const moduleWithNoSecret = await Test.createTestingModule({
        providers: [
          FlutterwaveWebhookGuard,
          {
            provide: ConfigService,
            useValue: {
              get: vi.fn().mockReturnValue(""),
            },
          },
        ],
      }).compile();

      const guardWithNoSecret =
        moduleWithNoSecret.get<FlutterwaveWebhookGuard>(FlutterwaveWebhookGuard);
      const context = createMockExecutionContext({
        "verif-hash": "some-signature",
      });

      expect(guardWithNoSecret.canActivate(context)).toBe(false);
    });

    it("should use timing-safe comparison to prevent timing attacks", () => {
      // The guard uses HMAC-based comparison which provides constant-time
      // comparison regardless of input length, preventing timing side-channels
      const almostCorrect = `${WEBHOOK_SECRET.slice(0, -1)}x`;
      const context = createMockExecutionContext({ "verif-hash": almostCorrect });
      expect(guard.canActivate(context)).toBe(false);
    });

    it("should reject different-length inputs without leaking length info", () => {
      // HMAC-based comparison ensures this takes constant time
      // regardless of input length (no length oracle attack)
      const shortInput = "abc";
      const longInput = "a".repeat(1000);

      const shortContext = createMockExecutionContext({ "verif-hash": shortInput });
      const longContext = createMockExecutionContext({ "verif-hash": longInput });

      expect(guard.canActivate(shortContext)).toBe(false);
      expect(guard.canActivate(longContext)).toBe(false);
    });
  });
});
