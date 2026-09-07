import { type CanActivate, type ExecutionContext, Injectable } from "@nestjs/common";
import {
  InjectThrottlerStorage,
  ThrottlerException,
  type ThrottlerStorage,
} from "@nestjs/throttler";
import type { Request, Response } from "express";
import { enforceNamedIpThrottle } from "../../common/throttling/throttling.helper";

export const VERIFICATION_THROTTLE_CONFIG = {
  name: "vehicle-verification",
  ttlMs: 60_000,
  ttlSeconds: 60,
  limit: 10,
} as const;

@Injectable()
export class VerificationThrottlerGuard implements CanActivate {
  constructor(
    @InjectThrottlerStorage()
    private readonly throttlerStorage: ThrottlerStorage,
  ) {}

  canActivate(context: ExecutionContext): Promise<boolean> {
    return enforceNamedIpThrottle({
      request: context.switchToHttp().getRequest<Request>(),
      response: context.switchToHttp().getResponse<Response>(),
      storage: this.throttlerStorage,
      config: VERIFICATION_THROTTLE_CONFIG,
      fallbackPath: "verification",
      createException: () => new ThrottlerException(),
    });
  }
}
