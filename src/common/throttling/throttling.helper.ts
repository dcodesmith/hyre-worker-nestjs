import type { ThrottlerStorage } from "@nestjs/throttler";
import { readClientRequest } from "../client-request";

export interface HeaderWritable {
  setHeader(name: string, value: string): void;
}

export interface HttpRequestLike {
  ip?: string;
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  route?: { path?: string };
}

export interface NamedIpThrottleConfig {
  name: string;
  ttlMs: number;
  ttlSeconds: number;
  limit: number;
}

export type ThrottleHitRecord = Awaited<ReturnType<ThrottlerStorage["increment"]>>;

export function getClientIp(request: HttpRequestLike, edgeSecret?: string): string {
  return readClientRequest(request.headers, edgeSecret).ipAddress ?? request.ip ?? "unknown";
}

export function isThrottled(hit: ThrottleHitRecord, limit: number): boolean {
  if (hit.isBlocked !== undefined) {
    return hit.isBlocked;
  }

  return hit.totalHits > limit;
}

export function getRetryAfterSeconds(hit: ThrottleHitRecord, fallbackSeconds: number): number {
  const retryAfterMs = hit.timeToBlockExpire || hit.timeToExpire;
  const retryAfterSeconds =
    typeof retryAfterMs === "number" && retryAfterMs > 0
      ? Math.ceil(retryAfterMs / 1000)
      : fallbackSeconds;
  return Math.max(1, retryAfterSeconds);
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

export async function enforceNamedIpThrottle(input: {
  request: HttpRequestLike;
  response: HeaderWritable;
  storage: ThrottlerStorage;
  config: NamedIpThrottleConfig;
  fallbackPath: string;
  createException: () => Error;
  edgeSecret?: string;
}): Promise<true> {
  const tracker = getClientIp(input.request, input.edgeSecret);
  const routePath = input.request.route?.path || input.fallbackPath;
  const method = input.request.method || "GET";
  const key = `${input.config.name}:${method}:${routePath}:${tracker}`;

  const hit = await input.storage.increment(
    key,
    input.config.ttlMs,
    input.config.limit,
    input.config.ttlMs,
    input.config.name,
  );

  if (!isThrottled(hit, input.config.limit)) {
    return true;
  }

  const retryAfterSeconds = getRetryAfterSeconds(hit, input.config.ttlSeconds);
  setRateLimitHeaders(input.response, {
    limit: input.config.limit,
    windowSeconds: input.config.ttlSeconds,
    retryAfterSeconds,
    remaining: 0,
  });

  throw input.createException();
}
