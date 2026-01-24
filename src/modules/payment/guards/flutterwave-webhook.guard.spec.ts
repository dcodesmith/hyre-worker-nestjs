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
      // This test verifies the guard handles similar-length strings correctly
      // The actual timing-safe behavior is provided by Node's timingSafeEqual
      const almostCorrect = `${WEBHOOK_SECRET.slice(0, -1)}x`;
      const context = createMockExecutionContext({ "verif-hash": almostCorrect });
      expect(guard.canActivate(context)).toBe(false);
    });
  });
});
