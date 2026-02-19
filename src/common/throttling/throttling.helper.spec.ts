import { describe, expect, it } from "vitest";
import { getRetryAfterSeconds, type ThrottleHitRecord } from "./throttling.helper";

describe("getRetryAfterSeconds", () => {
  it("converts timeToBlockExpire from milliseconds to seconds", () => {
    const hit = { timeToBlockExpire: 3_600_000 } as unknown as ThrottleHitRecord;

    expect(getRetryAfterSeconds(hit, 60)).toBe(3600);
  });

  it("falls back to timeToExpire when timeToBlockExpire is missing", () => {
    const hit = { timeToExpire: 1250 } as unknown as ThrottleHitRecord;

    expect(getRetryAfterSeconds(hit, 60)).toBe(2);
  });

  it("uses fallback seconds when throttler values are unavailable", () => {
    const hit = {} as unknown as ThrottleHitRecord;

    expect(getRetryAfterSeconds(hit, 3600)).toBe(3600);
  });

  it("returns at least one second", () => {
    const hit = { timeToExpire: 0 } as unknown as ThrottleHitRecord;

    expect(getRetryAfterSeconds(hit, 0)).toBe(1);
  });
});
