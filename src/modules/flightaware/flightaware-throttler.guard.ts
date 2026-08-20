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
import { FlightSearchRateLimitExceededException } from "./flightaware.error";
import { FLIGHT_SEARCH_THROTTLE_CONFIG } from "./flightaware-throttling.config";

@Injectable()
export class FlightSearchThrottlerGuard implements CanActivate {
  constructor(
    @InjectThrottlerStorage()
    private readonly throttlerStorage: ThrottlerStorage,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const tracker = getClientIp(request);
    const routePath = request.route?.path || "search-flight";
    const method = request.method || "GET";
    const key = `${FLIGHT_SEARCH_THROTTLE_CONFIG.name}:${method}:${routePath}:${tracker}`;

    const hit = await this.throttlerStorage.increment(
      key,
      FLIGHT_SEARCH_THROTTLE_CONFIG.ttlMs,
      FLIGHT_SEARCH_THROTTLE_CONFIG.limit,
      FLIGHT_SEARCH_THROTTLE_CONFIG.ttlMs,
      FLIGHT_SEARCH_THROTTLE_CONFIG.name,
    );
    const blocked = isThrottled(hit, FLIGHT_SEARCH_THROTTLE_CONFIG.limit);
    if (!blocked) {
      return true;
    }

    const retryAfterSeconds = getRetryAfterSeconds(hit, FLIGHT_SEARCH_THROTTLE_CONFIG.ttlSeconds);
    setRateLimitHeaders(response, {
      limit: FLIGHT_SEARCH_THROTTLE_CONFIG.limit,
      windowSeconds: FLIGHT_SEARCH_THROTTLE_CONFIG.ttlSeconds,
      retryAfterSeconds,
      remaining: 0,
    });

    throw new FlightSearchRateLimitExceededException();
  }
}
