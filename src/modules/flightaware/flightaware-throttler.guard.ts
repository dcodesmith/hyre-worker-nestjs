import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import type { ThrottlerStorage } from "@nestjs/throttler";
import { InjectThrottlerStorage } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { enforceNamedIpThrottle } from "../../common/throttling/throttling.helper";
import { FlightSearchRateLimitExceededException } from "./flightaware.error";
import { FLIGHT_SEARCH_THROTTLE_CONFIG } from "./flightaware-throttling.config";

@Injectable()
export class FlightSearchThrottlerGuard implements CanActivate {
  constructor(
    @InjectThrottlerStorage()
    private readonly throttlerStorage: ThrottlerStorage,
  ) {}

  canActivate(context: ExecutionContext): Promise<boolean> {
    return enforceNamedIpThrottle({
      request: context.switchToHttp().getRequest<Request>(),
      response: context.switchToHttp().getResponse<Response>(),
      storage: this.throttlerStorage,
      config: FLIGHT_SEARCH_THROTTLE_CONFIG,
      fallbackPath: "search-flight",
      createException: () => new FlightSearchRateLimitExceededException(),
    });
  }
}
