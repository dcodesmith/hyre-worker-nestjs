import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import type { ThrottlerStorage } from "@nestjs/throttler";
import { InjectThrottlerStorage } from "@nestjs/throttler";
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
import { REFERRAL_THROTTLE_CONFIG } from "./referral-throttling.config";

@Injectable()
export class ReferralThrottlerGuard implements CanActivate {
  constructor(
    @InjectThrottlerStorage()
    private readonly throttlerStorage: ThrottlerStorage,
  ) {}

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

    const [userHit, ipHit] = await Promise.all([
      this.throttlerStorage.increment(
        `${REFERRAL_THROTTLE_CONFIG.name}:user:${method}:${routePath}:${userTracker}`,
        REFERRAL_THROTTLE_CONFIG.ttlMs,
        REFERRAL_THROTTLE_CONFIG.userLimit,
        REFERRAL_THROTTLE_CONFIG.ttlMs,
        REFERRAL_THROTTLE_CONFIG.name,
      ),
      this.throttlerStorage.increment(
        `${REFERRAL_THROTTLE_CONFIG.name}:ip:${method}:${routePath}:${ipTracker}`,
        REFERRAL_THROTTLE_CONFIG.ttlMs,
        REFERRAL_THROTTLE_CONFIG.ipLimit,
        REFERRAL_THROTTLE_CONFIG.ttlMs,
        REFERRAL_THROTTLE_CONFIG.name,
      ),
    ]);

    const userBlocked = isThrottled(userHit, REFERRAL_THROTTLE_CONFIG.userLimit);
    const ipBlocked = isThrottled(ipHit, REFERRAL_THROTTLE_CONFIG.ipLimit);

    if (!userBlocked && !ipBlocked) {
      return true;
    }

    const activeHit = userBlocked ? userHit : ipHit;
    const activeLimit = userBlocked
      ? REFERRAL_THROTTLE_CONFIG.userLimit
      : REFERRAL_THROTTLE_CONFIG.ipLimit;
    const retryAfter = getRetryAfterSeconds(activeHit, REFERRAL_THROTTLE_CONFIG.ttlSeconds);

    setRateLimitHeaders(response, {
      limit: activeLimit,
      windowSeconds: REFERRAL_THROTTLE_CONFIG.ttlSeconds,
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
