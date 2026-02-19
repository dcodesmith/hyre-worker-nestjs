import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import { ThrottlerStorage } from "@nestjs/throttler";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JobRateLimitExceededException } from "./errors";
import { JobThrottlerGuard } from "./job-throttler.guard";

class TestableJobThrottlerGuard extends JobThrottlerGuard {
  async callThrowThrottlingException(
    context: ExecutionContext,
    throttlerConfig?: { ttl: number },
  ): Promise<void> {
    return this.throwThrottlingException(context, throttlerConfig);
  }
}

function createContext(jobType: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ params: { jobType } }),
    }),
  } as unknown as ExecutionContext;
}

describe("JobThrottlerGuard", () => {
  let guard: TestableJobThrottlerGuard;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: TestableJobThrottlerGuard,
          useClass: TestableJobThrottlerGuard,
        },
        {
          provide: "THROTTLER:MODULE_OPTIONS",
          useValue: [{ name: "manual-triggers", ttl: 3600, limit: 1 }],
        },
        {
          provide: ThrottlerStorage,
          useValue: { increment: vi.fn(), get: vi.fn() },
        },
        Reflector,
      ],
    }).compile();

    guard = module.get<TestableJobThrottlerGuard>(TestableJobThrottlerGuard);
  });

  it("converts millisecond ttl to seconds for retryAfter", async () => {
    const nowSeconds = Math.ceil(Date.now() / 1000);

    await expect(
      guard.callThrowThrottlingException(createContext("start-reminders"), { ttl: 3_600_000 }),
    ).rejects.toThrow(JobRateLimitExceededException);

    try {
      await guard.callThrowThrottlingException(createContext("start-reminders"), {
        ttl: 3_600_000,
      });
    } catch (error) {
      const details = (error as JobRateLimitExceededException).getDetails();
      const retryAfter = details?.retryAfter as number;

      expect(retryAfter).toBeGreaterThanOrEqual(nowSeconds + 3300);
      expect(retryAfter).toBeLessThanOrEqual(nowSeconds + 3900);
    }
  });

  it("keeps second-based ttl values unchanged", async () => {
    const nowSeconds = Math.ceil(Date.now() / 1000);

    try {
      await guard.callThrowThrottlingException(createContext("start-reminders"), { ttl: 3600 });
    } catch (error) {
      const details = (error as JobRateLimitExceededException).getDetails();
      const retryAfter = details?.retryAfter as number;

      expect(retryAfter).toBeGreaterThanOrEqual(nowSeconds + 3300);
      expect(retryAfter).toBeLessThanOrEqual(nowSeconds + 3900);
    }
  });

  it("uses 1 hour fallback when ttl is missing", async () => {
    const nowSeconds = Math.ceil(Date.now() / 1000);

    try {
      await guard.callThrowThrottlingException(createContext("start-reminders"));
    } catch (error) {
      const details = (error as JobRateLimitExceededException).getDetails();
      const retryAfter = details?.retryAfter as number;

      expect(retryAfter).toBeGreaterThanOrEqual(nowSeconds + 3300);
      expect(retryAfter).toBeLessThanOrEqual(nowSeconds + 3900);
    }
  });
});
