import { type CanActivate, type ExecutionContext, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  InjectThrottlerStorage,
  ThrottlerException,
  type ThrottlerStorage,
} from "@nestjs/throttler";
import type { Request, Response } from "express";
import { readClientRequest } from "../../common/client-request";
import { enforceNamedIpThrottle } from "../../common/throttling/throttling.helper";
import type { EnvConfig } from "../../config/env.config";

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
    private readonly configService: ConfigService<EnvConfig, true>,
  ) {}

  canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const client = readClientRequest(
      request.headers,
      this.configService.get("EDGE_CLIENT_SECRET", { infer: true }),
    );
    return enforceNamedIpThrottle({
      request: {
        ip: client.ipAddress ?? request.ip,
        method: request.method,
        route: request.route,
      },
      response: context.switchToHttp().getResponse<Response>(),
      storage: this.throttlerStorage,
      config: VERIFICATION_THROTTLE_CONFIG,
      fallbackPath: "verification",
      createException: () => new ThrottlerException(),
    });
  }
}
