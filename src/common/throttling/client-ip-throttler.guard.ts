import { Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from "@nestjs/throttler";
import type { EnvConfig } from "../../config/env.config";
import { getClientIp, type HttpRequestLike } from "./throttling.helper";

/**
 * ThrottlerGuard that tracks requests by trusted client IP (`cf-connecting-ip`
 * when authenticated with `EDGE_CLIENT_SECRET`, else `fly-client-ip`, else `req.ip`).
 */
@Injectable()
export class ClientIpThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    @Optional() private readonly configService?: ConfigService<EnvConfig>,
  ) {
    super(options, storageService, reflector);
  }

  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    return getClientIp(
      req as HttpRequestLike,
      this.configService?.get("EDGE_CLIENT_SECRET", { infer: true }),
    );
  }
}
