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
import { PlacesRateLimitExceededException } from "./maps.error";
import { PLACES_THROTTLE_CONFIG, type PlacesThrottleOperation } from "./places-throttling.config";

@Injectable()
export class PlacesThrottlerGuard implements CanActivate {
  constructor(
    @InjectThrottlerStorage()
    private readonly throttlerStorage: ThrottlerStorage,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const tracker = getClientIp(request);
    const operation = this.resolveOperation(request);
    const limit = PLACES_THROTTLE_CONFIG.limits[operation];
    const routePath = request.route?.path || operation;
    const method = request.method || "GET";
    const key = `${PLACES_THROTTLE_CONFIG.name}:${operation}:${method}:${routePath}:${tracker}`;

    const hit = await this.throttlerStorage.increment(
      key,
      PLACES_THROTTLE_CONFIG.ttlMs,
      limit,
      PLACES_THROTTLE_CONFIG.ttlMs,
      PLACES_THROTTLE_CONFIG.name,
    );
    const blocked = isThrottled(hit, limit);
    if (!blocked) {
      return true;
    }

    const retryAfterSeconds = getRetryAfterSeconds(hit, PLACES_THROTTLE_CONFIG.ttlSeconds);
    setRateLimitHeaders(response, {
      limit,
      windowSeconds: PLACES_THROTTLE_CONFIG.ttlSeconds,
      retryAfterSeconds,
      remaining: 0,
    });

    throw new PlacesRateLimitExceededException();
  }

  private resolveOperation(request: Request): PlacesThrottleOperation {
    const routePath = request.route?.path;
    const normalizedPath =
      typeof routePath === "string"
        ? (routePath
            .split("/")
            .map((segment) => segment.trim())
            .filter(Boolean)
            .at(-1) ?? "")
        : "";

    if (normalizedPath === "autocomplete") {
      return "autocomplete";
    }
    if (normalizedPath === "resolve") {
      return "resolve";
    }
    return "validate";
  }
}
