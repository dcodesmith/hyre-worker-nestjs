import type { ExecutionContext } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import type { EnvConfig } from "src/config/env.config";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FlightAwareWebhookGuard } from "./flightaware-webhook.guard";

describe("FlightAwareWebhookGuard", () => {
  let guard: FlightAwareWebhookGuard;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FlightAwareWebhookGuard,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: vi.fn((key: keyof EnvConfig) => {
              if (key === "FLIGHTAWARE_WEBHOOK_SECRET") return "secret-123";
              if (key === "HMAC_KEY") return "test-hmac-key";
              throw new Error(`Missing key: ${key}`);
            }),
          },
        },
      ],
    }).compile();

    guard = module.get<FlightAwareWebhookGuard>(FlightAwareWebhookGuard);
  });

  const createContext = (secret?: string): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({
          query: secret ? { secret } : {},
        }),
      }),
    }) as ExecutionContext;

  it("allows request with valid query secret", () => {
    const context = createContext("secret-123");
    expect(guard.canActivate(context)).toBe(true);
  });

  it("rejects request with invalid query secret", () => {
    const context = createContext("wrong");
    expect(guard.canActivate(context)).toBe(false);
  });

  it("rejects request when query secret is missing", () => {
    const context = createContext();
    expect(guard.canActivate(context)).toBe(false);
  });
});
