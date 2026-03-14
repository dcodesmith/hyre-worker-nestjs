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
import { AiSearchRateLimitExceededException } from "./ai-search.error";
import { AI_SEARCH_THROTTLE_CONFIG } from "./ai-search-throttling.config";

@Injectable()
export class AiSearchThrottlerGuard implements CanActivate {
  constructor(
    @InjectThrottlerStorage()
    private readonly throttlerStorage: ThrottlerStorage,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const tracker = getClientIp(request);
    const routePath = request.route?.path || "ai-search";
    const method = request.method || "POST";
    const key = `${AI_SEARCH_THROTTLE_CONFIG.name}:${method}:${routePath}:${tracker}`;

    const hit = await this.throttlerStorage.increment(
      key,
      AI_SEARCH_THROTTLE_CONFIG.ttlMs,
      AI_SEARCH_THROTTLE_CONFIG.limit,
      AI_SEARCH_THROTTLE_CONFIG.ttlMs,
      AI_SEARCH_THROTTLE_CONFIG.name,
    );
    const blocked = isThrottled(hit, AI_SEARCH_THROTTLE_CONFIG.limit);
    if (!blocked) {
      return true;
    }

    const retryAfterSeconds = getRetryAfterSeconds(hit, AI_SEARCH_THROTTLE_CONFIG.ttlSeconds);
    setRateLimitHeaders(response, {
      limit: AI_SEARCH_THROTTLE_CONFIG.limit,
      windowSeconds: AI_SEARCH_THROTTLE_CONFIG.ttlSeconds,
      retryAfterSeconds,
      remaining: 0,
    });

    throw new AiSearchRateLimitExceededException();
  }
}
