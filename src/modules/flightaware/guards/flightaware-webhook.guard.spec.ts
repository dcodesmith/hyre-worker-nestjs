import type { ExecutionContext } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import type { EnvConfig } from "src/config/env.config";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { createHmacSignature } from "../../../common/security/webhook-signature.helper";
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
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    guard = module.get<FlightAwareWebhookGuard>(FlightAwareWebhookGuard);
  });

  const createContext = (flightId?: string, signature?: string): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({
          query: flightId && signature ? { flightId, signature } : {},
        }),
      }),
    }) as ExecutionContext;

  it("allows request with a valid flight-scoped signature", () => {
    const context = createContext("flight-1", createHmacSignature("flight-1", "secret-123"));
    expect(guard.canActivate(context)).toBe(true);
  });

  it("rejects a signature created for another flight", () => {
    const context = createContext("flight-2", createHmacSignature("flight-1", "secret-123"));
    expect(guard.canActivate(context)).toBe(false);
  });

  it("rejects request when the signature is missing", () => {
    const context = createContext();
    expect(guard.canActivate(context)).toBe(false);
  });
});
