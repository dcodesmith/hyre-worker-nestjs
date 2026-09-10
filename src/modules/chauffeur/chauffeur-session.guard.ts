import { createHmac } from "node:crypto";
import { type CanActivate, type ExecutionContext, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";
import type { EnvConfig } from "../../config/env.config";
import { DatabaseService } from "../database/database.service";
import { ChauffeurSessionInvalidException } from "./chauffeur.error";

export const CHAUFFEUR_VERIFICATION_ID = "chauffeurVerificationId";

@Injectable()
export class ChauffeurSessionGuard implements CanActivate {
  private readonly hashKey: string;

  constructor(
    configService: ConfigService<EnvConfig, true>,
    private readonly databaseService: DatabaseService,
  ) {
    this.hashKey = configService.get("HMAC_KEY", { infer: true });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { [CHAUFFEUR_VERIFICATION_ID]?: string }>();
    const token = this.bearerToken(request.headers.authorization);
    if (!token) {
      throw new ChauffeurSessionInvalidException();
    }

    const verification = await this.databaseService.chauffeurVerification.findFirst({
      where: {
        sessionTokenHash: this.hash(token),
        sessionExpiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    if (!verification) {
      throw new ChauffeurSessionInvalidException();
    }

    request[CHAUFFEUR_VERIFICATION_ID] = verification.id;
    return true;
  }

  private bearerToken(authorization?: string): string | null {
    const [scheme, token] = authorization?.split(" ") ?? [];
    return scheme === "Bearer" && token ? token : null;
  }

  private hash(value: string): string {
    return createHmac("sha256", this.hashKey).update(value).digest("hex");
  }
}
