import type { ExecutionContext } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { ThrottlerException, ThrottlerModule } from "@nestjs/throttler";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JOB_THROTTLE_CONFIG } from "../job/job-throttling.config";
import {
  VERIFICATION_THROTTLE_CONFIG,
  VerificationThrottlerGuard,
} from "./verification-throttler.guard";

describe("VerificationThrottlerGuard", () => {
  let guard: VerificationThrottlerGuard;
  let context: ExecutionContext;
  let setHeader: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([
          {
            name: JOB_THROTTLE_CONFIG.name,
            ttl: JOB_THROTTLE_CONFIG.ttlMs,
            limit: JOB_THROTTLE_CONFIG.limit,
          },
          {
            name: VERIFICATION_THROTTLE_CONFIG.name,
            ttl: VERIFICATION_THROTTLE_CONFIG.ttlMs,
            limit: VERIFICATION_THROTTLE_CONFIG.limit,
          },
        ]),
      ],
      providers: [VerificationThrottlerGuard],
    }).compile();

    guard = module.get(VerificationThrottlerGuard);
    setHeader = vi.fn();
    context = {
      switchToHttp: () => ({
        getRequest: () => ({
          ip: "203.0.113.10",
          method: "POST",
          route: { path: "/api/fleet-owner/vehicle-verifications" },
          headers: {},
        }),
        getResponse: () => ({ setHeader }),
      }),
    } as ExecutionContext;
  });

  it("uses the named vehicle-verification 10/minute limit, not the 1-request manual-trigger limiter", async () => {
    expect(VERIFICATION_THROTTLE_CONFIG).toEqual({
      name: "vehicle-verification",
      ttlMs: 60_000,
      ttlSeconds: 60,
      limit: 10,
    });
    expect(JOB_THROTTLE_CONFIG.limit).toBe(1);

    for (let count = 0; count < VERIFICATION_THROTTLE_CONFIG.limit; count += 1) {
      await expect(guard.canActivate(context)).resolves.toBe(true);
    }

    await expect(guard.canActivate(context)).rejects.toThrow(ThrottlerException);
    expect(setHeader).toHaveBeenCalledWith("Retry-After", expect.any(String));
    expect(setHeader).toHaveBeenCalledWith(
      "RateLimit-Policy",
      `${VERIFICATION_THROTTLE_CONFIG.limit};w=${VERIFICATION_THROTTLE_CONFIG.ttlSeconds}`,
    );
  });
});
