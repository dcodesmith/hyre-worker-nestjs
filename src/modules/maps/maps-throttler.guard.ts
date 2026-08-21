import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import type { ThrottlerStorage } from "@nestjs/throttler";
import { InjectThrottlerStorage } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { enforceNamedIpThrottle } from "../../common/throttling/throttling.helper";
import { TripDurationRateLimitExceededException } from "./maps.error";
import { TRIP_DURATION_THROTTLE_CONFIG } from "./maps-throttling.config";

@Injectable()
export class TripDurationThrottlerGuard implements CanActivate {
  constructor(
    @InjectThrottlerStorage()
    private readonly throttlerStorage: ThrottlerStorage,
  ) {}

  canActivate(context: ExecutionContext): Promise<boolean> {
    return enforceNamedIpThrottle({
      request: context.switchToHttp().getRequest<Request>(),
      response: context.switchToHttp().getResponse<Response>(),
      storage: this.throttlerStorage,
      config: TRIP_DURATION_THROTTLE_CONFIG,
      fallbackPath: "calculate-trip-duration",
      createException: () => new TripDurationRateLimitExceededException(),
    });
  }
}
