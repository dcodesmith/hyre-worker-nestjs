import { type CanActivate, type ExecutionContext, Injectable } from "@nestjs/common";
import { FleetOwnerStatus } from "@prisma/client";
import type { Request } from "express";
import { DatabaseService } from "../../database/database.service";
import { AuthErrorCode, AuthForbiddenException } from "../auth.error";
import { AUTH_SESSION_KEY, type AuthSession } from "./session.guard";

@Injectable()
export class VerifiedFleetOwnerGuard implements CanActivate {
  constructor(private readonly databaseService: DatabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { [AUTH_SESSION_KEY]?: AuthSession }>();
    const userId = request[AUTH_SESSION_KEY]?.user.id;
    const owner = userId
      ? await this.databaseService.user.findUnique({
          where: { id: userId },
          select: {
            emailVerified: true,
            phoneVerifiedAt: true,
            hasOnboarded: true,
            fleetOwnerStatus: true,
          },
        })
      : null;

    if (
      !owner?.emailVerified ||
      !owner.phoneVerifiedAt ||
      !owner.hasOnboarded ||
      owner.fleetOwnerStatus !== FleetOwnerStatus.APPROVED
    ) {
      throw new AuthForbiddenException(
        AuthErrorCode.AUTH_FLEET_OWNER_VERIFICATION_REQUIRED,
        "Complete fleet-owner account verification before using this feature",
        "Fleet Owner Verification Required",
      );
    }
    return true;
  }
}
