import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import type { ThrottlerStorage } from "@nestjs/throttler";
import { InjectThrottlerStorage } from "@nestjs/throttler";
import type { Request, Response } from "express";
import {
  getClientIp,
  getRetryAfterSeconds,
  isThrottled,
  setRateLimitHeaders,
} from "../../common/throttling/throttling.helper";
import { TripDurationRateLimitExceededException } from "./maps.error";
import { TRIP_DURATION_THROTTLE_CONFIG } from "./maps-throttling.config";

@Injectable()
export class TripDurationThrottlerGuard implements CanActivate {
  constructor(
    @InjectThrottlerStorage()
    private readonly throttlerStorage: ThrottlerStorage,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const tracker = getClientIp(request);
    const routePath = request.route?.path || "calculate-trip-duration";
    const method = request.method || "GET";
    const key = `${TRIP_DURATION_THROTTLE_CONFIG.name}:${method}:${routePath}:${tracker}`;

    const hit = await this.throttlerStorage.increment(
      key,
      TRIP_DURATION_THROTTLE_CONFIG.ttlMs,
      TRIP_DURATION_THROTTLE_CONFIG.limit,
      TRIP_DURATION_THROTTLE_CONFIG.ttlMs,
      TRIP_DURATION_THROTTLE_CONFIG.name,
    );
    const blocked = isThrottled(hit, TRIP_DURATION_THROTTLE_CONFIG.limit);
    if (!blocked) {
      return true;
    }

    const retryAfterSeconds = getRetryAfterSeconds(hit, TRIP_DURATION_THROTTLE_CONFIG.ttlSeconds);
    setRateLimitHeaders(response, {
      limit: TRIP_DURATION_THROTTLE_CONFIG.limit,
      windowSeconds: TRIP_DURATION_THROTTLE_CONFIG.ttlSeconds,
      retryAfterSeconds,
      remaining: 0,
    });

    throw new TripDurationRateLimitExceededException();
  }
}
