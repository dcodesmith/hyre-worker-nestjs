import type { ExecutionContext } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { ThrottlerModule } from "@nestjs/throttler";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TripDurationRateLimitExceededException } from "./maps.error";
import { TripDurationThrottlerGuard } from "./maps-throttler.guard";
import { TRIP_DURATION_THROTTLE_CONFIG } from "./maps-throttling.config";

describe("TripDurationThrottlerGuard", () => {
  let guard: TripDurationThrottlerGuard;
  let setHeader: ReturnType<typeof vi.fn>;
  let context: ExecutionContext;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([
          {
            name: TRIP_DURATION_THROTTLE_CONFIG.name,
            ttl: TRIP_DURATION_THROTTLE_CONFIG.ttlMs,
            limit: TRIP_DURATION_THROTTLE_CONFIG.limit,
          },
        ]),
      ],
      providers: [TripDurationThrottlerGuard],
    }).compile();

    guard = module.get<TripDurationThrottlerGuard>(TripDurationThrottlerGuard);
    setHeader = vi.fn();

    const request = {
      ip: "203.0.113.10",
      method: "GET",
      route: { path: "/api/calculate-trip-duration" },
      headers: {},
    };
    const response = { setHeader };

    context = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as ExecutionContext;
  });

  it("allows requests under the configured limit", async () => {
    for (let count = 0; count < TRIP_DURATION_THROTTLE_CONFIG.limit; count += 1) {
      await expect(guard.canActivate(context)).resolves.toBe(true);
    }
  });

  it("blocks requests above the configured limit and sets rate-limit headers", async () => {
    for (let count = 0; count < TRIP_DURATION_THROTTLE_CONFIG.limit; count += 1) {
      await guard.canActivate(context);
    }

    await expect(guard.canActivate(context)).rejects.toThrow(
      TripDurationRateLimitExceededException,
    );

    expect(setHeader).toHaveBeenCalledWith("Retry-After", expect.any(String));
    expect(setHeader).toHaveBeenCalledWith(
      "RateLimit-Policy",
      `${TRIP_DURATION_THROTTLE_CONFIG.limit};w=${TRIP_DURATION_THROTTLE_CONFIG.ttlSeconds}`,
    );
  });
});
