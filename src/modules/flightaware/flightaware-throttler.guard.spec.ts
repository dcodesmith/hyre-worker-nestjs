import type { ExecutionContext } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { ThrottlerModule } from "@nestjs/throttler";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FlightSearchRateLimitExceededException } from "./flightaware.error";
import { FlightSearchThrottlerGuard } from "./flightaware-throttler.guard";
import { FLIGHT_SEARCH_THROTTLE_CONFIG } from "./flightaware-throttling.config";

describe("FlightSearchThrottlerGuard", () => {
  let guard: FlightSearchThrottlerGuard;
  let setHeader: ReturnType<typeof vi.fn>;
  let context: ExecutionContext;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([
          {
            name: FLIGHT_SEARCH_THROTTLE_CONFIG.name,
            ttl: FLIGHT_SEARCH_THROTTLE_CONFIG.ttlMs,
            limit: FLIGHT_SEARCH_THROTTLE_CONFIG.limit,
          },
        ]),
      ],
      providers: [FlightSearchThrottlerGuard],
    }).compile();

    guard = module.get<FlightSearchThrottlerGuard>(FlightSearchThrottlerGuard);
    setHeader = vi.fn();

    const request = {
      ip: "203.0.113.10",
      method: "GET",
      route: { path: "/api/search-flight" },
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
    for (let count = 0; count < FLIGHT_SEARCH_THROTTLE_CONFIG.limit; count += 1) {
      await expect(guard.canActivate(context)).resolves.toBe(true);
    }
  });

  it("blocks requests above the configured limit and sets rate-limit headers", async () => {
    for (let count = 0; count < FLIGHT_SEARCH_THROTTLE_CONFIG.limit; count += 1) {
      await guard.canActivate(context);
    }

    await expect(guard.canActivate(context)).rejects.toThrow(
      FlightSearchRateLimitExceededException,
    );

    expect(setHeader).toHaveBeenCalledWith("Retry-After", expect.any(String));
    expect(setHeader).toHaveBeenCalledWith(
      "RateLimit-Policy",
      `${FLIGHT_SEARCH_THROTTLE_CONFIG.limit};w=${FLIGHT_SEARCH_THROTTLE_CONFIG.ttlSeconds}`,
    );
  });
});
