import type { ExecutionContext } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
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
  let configGet: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    configGet = vi.fn().mockReturnValue(undefined);
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
      providers: [
        VerificationThrottlerGuard,
        { provide: ConfigService, useValue: { get: configGet } },
      ],
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

  it("throttles the socket address and ignores a caller-supplied x-forwarded-for", async () => {
    const makeContext = (forwardedFor: string, ip = "127.0.0.1"): ExecutionContext =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({
            ip,
            method: "POST",
            route: { path: "/api/fleet-owner/vehicle-verifications" },
            headers: { "x-forwarded-for": forwardedFor },
          }),
          getResponse: () => ({ setHeader }),
        }),
      }) as ExecutionContext;

    for (let count = 0; count < VERIFICATION_THROTTLE_CONFIG.limit; count += 1) {
      await expect(guard.canActivate(makeContext(`203.0.113.${count}`))).resolves.toBe(true);
    }
    await expect(guard.canActivate(makeContext("198.51.100.20"))).rejects.toThrow(
      ThrottlerException,
    );
    await expect(guard.canActivate(makeContext("198.51.100.20", "192.0.2.10"))).resolves.toBe(true);
  });

  it("throttles the trusted edge or Fly client IP instead of x-forwarded-for", async () => {
    const spoofed = "203.0.113.99";
    const makeContext = (path: string, headers: Record<string, string>): ExecutionContext =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({
            ip: spoofed,
            method: "POST",
            route: { path },
            headers: { "x-forwarded-for": spoofed, ...headers },
          }),
          getResponse: () => ({ setHeader }),
        }),
      }) as ExecutionContext;

    const flyPath = "/api/bookings/guest-phone-verifications";
    for (let count = 0; count < VERIFICATION_THROTTLE_CONFIG.limit; count += 1) {
      await expect(
        guard.canActivate(makeContext(flyPath, { "fly-client-ip": "198.51.100.20" })),
      ).resolves.toBe(true);
    }
    await expect(
      guard.canActivate(makeContext(flyPath, { "fly-client-ip": "198.51.100.20" })),
    ).rejects.toThrow(ThrottlerException);
    await expect(
      guard.canActivate(makeContext(flyPath, { "fly-client-ip": "192.0.2.30" })),
    ).resolves.toBe(true);

    const secret = "edge-secret";
    configGet.mockReturnValue(secret);
    const edgePath = "/api/bookings/guest-phone-verification-checks";
    const edgeHeaders = {
      "x-hyre-edge": secret,
      "cf-connecting-ip": "203.0.113.10",
      "fly-client-ip": "198.51.100.20",
    };
    for (let count = 0; count < VERIFICATION_THROTTLE_CONFIG.limit; count += 1) {
      await expect(guard.canActivate(makeContext(edgePath, edgeHeaders))).resolves.toBe(true);
    }
    await expect(guard.canActivate(makeContext(edgePath, edgeHeaders))).rejects.toThrow(
      ThrottlerException,
    );
    await expect(
      guard.canActivate(
        makeContext(edgePath, { ...edgeHeaders, "cf-connecting-ip": "192.0.2.40" }),
      ),
    ).resolves.toBe(true);
  });
});
