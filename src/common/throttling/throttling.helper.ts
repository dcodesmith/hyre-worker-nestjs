import type { ThrottlerStorage } from "@nestjs/throttler";

export interface HeaderWritable {
  setHeader(name: string, value: string): void;
}

export interface HttpRequestLike {
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
}

export type ThrottleHitRecord = Awaited<ReturnType<ThrottlerStorage["increment"]>>;

export function getClientIp(request: HttpRequestLike): string {
  const forwardedFor = request.headers?.["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.length > 0) {
    return forwardedFor.split(",")[0].trim();
  }

  const cfIp = request.headers?.["cf-connecting-ip"];
  if (typeof cfIp === "string" && cfIp.length > 0) {
    return cfIp.trim();
  }

  const realIp = request.headers?.["x-real-ip"];
  if (typeof realIp === "string" && realIp.length > 0) {
    return realIp.trim();
  }

  return request.ip || "unknown";
}

export function isThrottled(hit: ThrottleHitRecord, limit: number): boolean {
  if (hit.isBlocked !== undefined) {
    return hit.isBlocked;
  }

  return hit.totalHits > limit;
}

export function getRetryAfterSeconds(hit: ThrottleHitRecord, fallbackSeconds: number): number {
  return Math.max(1, hit.timeToBlockExpire || hit.timeToExpire || fallbackSeconds);
}

export function setRateLimitHeaders(
  response: HeaderWritable,
  input: {
    limit: number;
    windowSeconds: number;
    retryAfterSeconds: number;
    remaining?: number;
  },
): void {
  response.setHeader("Retry-After", String(input.retryAfterSeconds));
  response.setHeader("RateLimit-Policy", `${input.limit};w=${input.windowSeconds}`);
  response.setHeader("RateLimit-Limit", String(input.limit));
  response.setHeader("RateLimit-Remaining", String(input.remaining ?? 0));
}

export function computeRetryAfterEpoch(ttlSeconds: number): number {
  return Math.ceil(Date.now() / 1000) + ttlSeconds;
}
