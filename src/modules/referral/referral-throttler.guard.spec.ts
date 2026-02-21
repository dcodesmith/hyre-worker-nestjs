import type { ExecutionContext } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { ThrottlerModule } from "@nestjs/throttler";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_SESSION_KEY } from "../auth/guards/session.guard";
import { ReferralRateLimitExceededException } from "./referral.error";
import { ReferralThrottlerGuard } from "./referral-throttler.guard";
import { REFERRAL_THROTTLE_CONFIG } from "./referral-throttling.config";

function createContext({
  userId = "user-1",
  ip = "10.10.10.10",
  response = { setHeader: vi.fn() },
}: {
  userId?: string;
  ip?: string;
  response?: { setHeader: ReturnType<typeof vi.fn> };
}): ExecutionContext {
  const request = {
    method: "GET",
    route: { path: "validate/:code" },
    headers: { "x-forwarded-for": ip },
    [AUTH_SESSION_KEY]: { user: { id: userId } },
  };

  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

describe("ReferralThrottlerGuard", () => {
  let guard: ReferralThrottlerGuard;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([
          {
            name: REFERRAL_THROTTLE_CONFIG.name,
            ttl: REFERRAL_THROTTLE_CONFIG.ttlMs,
            limit: REFERRAL_THROTTLE_CONFIG.userLimit,
          },
        ]),
      ],
      providers: [ReferralThrottlerGuard],
    }).compile();

    guard = module.get<ReferralThrottlerGuard>(ReferralThrottlerGuard);
  });

  it("resolves with throttler storage dependency", () => {
    expect(guard).toBeDefined();
  });

  it("allows request under rate limits", async () => {
    await expect(guard.canActivate(createContext({}))).resolves.toBe(true);
  });

  it("throws rate limit exception after user limit is exceeded", async () => {
    const response = { setHeader: vi.fn() };

    for (let attempt = 0; attempt < REFERRAL_THROTTLE_CONFIG.userLimit; attempt += 1) {
      await expect(guard.canActivate(createContext({ response }))).resolves.toBe(true);
    }

    await expect(guard.canActivate(createContext({ response }))).rejects.toThrow(
      ReferralRateLimitExceededException,
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      "RateLimit-Limit",
      String(REFERRAL_THROTTLE_CONFIG.userLimit),
    );
    expect(response.setHeader).toHaveBeenCalledWith("RateLimit-Remaining", "0");
  });
});
