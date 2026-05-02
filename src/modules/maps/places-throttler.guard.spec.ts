import type { ExecutionContext } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { ThrottlerModule } from "@nestjs/throttler";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlacesRateLimitExceededException } from "./maps.error";
import { PlacesThrottlerGuard } from "./places-throttler.guard";
import { PLACES_THROTTLE_CONFIG } from "./places-throttling.config";

describe("PlacesThrottlerGuard", () => {
  let guard: PlacesThrottlerGuard;
  let setHeader: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([
          {
            name: PLACES_THROTTLE_CONFIG.name,
            ttl: PLACES_THROTTLE_CONFIG.ttlMs,
            limit: PLACES_THROTTLE_CONFIG.limits.autocomplete,
          },
        ]),
      ],
      providers: [PlacesThrottlerGuard],
    }).compile();

    guard = module.get<PlacesThrottlerGuard>(PlacesThrottlerGuard);
    setHeader = vi.fn();
  });

  function createContext(method: string, path: string, ip = "203.0.113.10"): ExecutionContext {
    const request = {
      ip,
      method,
      route: { path },
      headers: {},
    };
    const response = { setHeader };

    return {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as unknown as ExecutionContext;
  }

  it("enforces per-route limit for autocomplete endpoint", async () => {
    const context = createContext("GET", "/autocomplete");
    for (let count = 0; count < PLACES_THROTTLE_CONFIG.limits.autocomplete; count += 1) {
      await expect(guard.canActivate(context)).resolves.toBe(true);
    }

    await expect(guard.canActivate(context)).rejects.toThrow(PlacesRateLimitExceededException);
    expect(setHeader).toHaveBeenCalledWith(
      "RateLimit-Policy",
      `${PLACES_THROTTLE_CONFIG.limits.autocomplete};w=${PLACES_THROTTLE_CONFIG.ttlSeconds}`,
    );
  });

  it("enforces per-route limit for resolve endpoint", async () => {
    const context = createContext("POST", "/resolve", "203.0.113.11");
    for (let count = 0; count < PLACES_THROTTLE_CONFIG.limits.resolve; count += 1) {
      await expect(guard.canActivate(context)).resolves.toBe(true);
    }

    await expect(guard.canActivate(context)).rejects.toThrow(PlacesRateLimitExceededException);
    expect(setHeader).toHaveBeenCalledWith(
      "RateLimit-Policy",
      `${PLACES_THROTTLE_CONFIG.limits.resolve};w=${PLACES_THROTTLE_CONFIG.ttlSeconds}`,
    );
  });
});
