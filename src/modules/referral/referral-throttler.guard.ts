import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { ThrottlerStorage } from "@nestjs/throttler";
import type { Response } from "express";
import {
  getClientIp,
  getRetryAfterSeconds,
  isThrottled,
  setRateLimitHeaders,
} from "../../common/throttling/throttling.helper";
import { AUTH_SESSION_KEY, type AuthSession } from "../auth/guards/session.guard";
import { ReferralRateLimitExceededException } from "./referral.error";
import type { ReferralThrottleRequestContext } from "./referral.interface";

@Injectable()
export class ReferralThrottlerGuard implements CanActivate {
  private readonly ttlMs = 60 * 60 * 1000;
  private readonly ttlSeconds = 60 * 60;
  private readonly userLimit = 20;
  private readonly ipLimit = 60;

  constructor(private readonly throttlerStorage: ThrottlerStorage) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<
      ReferralThrottleRequestContext & {
        [AUTH_SESSION_KEY]?: AuthSession;
      }
    >();
    const response = context.switchToHttp().getResponse<Response>();

    const ipTracker = getClientIp(request);
    const userTracker = this.getUserTracker(request);
    const routePath = request.route?.path || "validate";
    const method = request.method || "GET";

    const userHit = await this.throttlerStorage.increment(
      `referral-validation:user:${method}:${routePath}:${userTracker}`,
      this.ttlMs,
      this.userLimit,
      this.ttlMs,
      "referral-validation",
    );

    const ipHit = await this.throttlerStorage.increment(
      `referral-validation:ip:${method}:${routePath}:${ipTracker}`,
      this.ttlMs,
      this.ipLimit,
      this.ttlMs,
      "referral-validation",
    );

    const userBlocked = isThrottled(userHit, this.userLimit);
    const ipBlocked = isThrottled(ipHit, this.ipLimit);

    if (!userBlocked && !ipBlocked) {
      return true;
    }

    const activeHit = userBlocked ? userHit : ipHit;
    const activeLimit = userBlocked ? this.userLimit : this.ipLimit;
    const retryAfter = getRetryAfterSeconds(activeHit, this.ttlSeconds);

    setRateLimitHeaders(response, {
      limit: activeLimit,
      windowSeconds: this.ttlSeconds,
      retryAfterSeconds: retryAfter,
      remaining: 0,
    });

    throw new ReferralRateLimitExceededException();
  }

  private getUserTracker(
    request: ReferralThrottleRequestContext & {
      [AUTH_SESSION_KEY]?: AuthSession;
    },
  ): string {
    return request[AUTH_SESSION_KEY]?.user?.id || "anonymous";
  }
}
