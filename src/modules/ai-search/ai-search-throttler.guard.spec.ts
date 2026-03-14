import type { ExecutionContext } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { ThrottlerModule } from "@nestjs/throttler";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiSearchRateLimitExceededException } from "./ai-search.error";
import { AiSearchThrottlerGuard } from "./ai-search-throttler.guard";
import { AI_SEARCH_THROTTLE_CONFIG } from "./ai-search-throttling.config";

describe("AiSearchThrottlerGuard", () => {
  let guard: AiSearchThrottlerGuard;
  let setHeader: ReturnType<typeof vi.fn>;
  let context: ExecutionContext;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([
          {
            name: AI_SEARCH_THROTTLE_CONFIG.name,
            ttl: AI_SEARCH_THROTTLE_CONFIG.ttlMs,
            limit: AI_SEARCH_THROTTLE_CONFIG.limit,
          },
        ]),
      ],
      providers: [AiSearchThrottlerGuard],
    }).compile();

    guard = module.get<AiSearchThrottlerGuard>(AiSearchThrottlerGuard);
    setHeader = vi.fn();

    const request = {
      ip: "203.0.113.10",
      method: "POST",
      route: { path: "/ai-search" },
      headers: {},
    };
    const response = { setHeader };

    context = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as unknown as ExecutionContext;
  });

  it("allows requests under the configured limit", async () => {
    for (let count = 0; count < AI_SEARCH_THROTTLE_CONFIG.limit; count += 1) {
      await expect(guard.canActivate(context)).resolves.toBe(true);
    }
  });

  it("blocks requests above the configured limit and sets rate-limit headers", async () => {
    for (let count = 0; count < AI_SEARCH_THROTTLE_CONFIG.limit; count += 1) {
      await guard.canActivate(context);
    }

    await expect(guard.canActivate(context)).rejects.toThrow(AiSearchRateLimitExceededException);

    expect(setHeader).toHaveBeenCalledWith("Retry-After", expect.any(String));
    expect(setHeader).toHaveBeenCalledWith(
      "RateLimit-Policy",
      `${AI_SEARCH_THROTTLE_CONFIG.limit};w=${AI_SEARCH_THROTTLE_CONFIG.ttlSeconds}`,
    );
  });
});
