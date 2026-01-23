import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import type { RoleName } from "../auth.types";
import { ROLES_KEY } from "../decorators/roles.decorator";
import { AUTH_SESSION_KEY, type AuthSession } from "./session.guard";

/**
 * Guard that enforces role-based access control (RBAC).
 *
 * IMPORTANT: This guard MUST be used AFTER SessionGuard, as it relies on
 * the session being attached to the request by SessionGuard.
 *
 * Usage:
 * ```typescript
 * @UseGuards(SessionGuard, RoleGuard)
 * @Roles('admin', 'staff')
 * @Get('admin/dashboard')
 * getAdminDashboard() {
 *   return { message: 'Admin dashboard' };
 * }
 * ```
 *
 * If no @Roles() decorator is present, the guard allows access (authentication-only).
 * If @Roles() is present, the user must have at least one of the specified roles.
 */
@Injectable()
export class RoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Get required roles from the @Roles() decorator
    const requiredRoles = this.reflector.getAllAndOverride<RoleName[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // If no roles are required, allow access (authentication-only route)
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    // Get the session attached by SessionGuard
    const request = context
      .switchToHttp()
      .getRequest<Request & { [AUTH_SESSION_KEY]?: AuthSession }>();
    const authSession = request[AUTH_SESSION_KEY];

    if (!authSession) {
      // This should not happen if SessionGuard is used first
      throw new ForbiddenException(
        "Session not found. Ensure SessionGuard is used before RoleGuard.",
      );
    }

    const userRoles = authSession.user.roles;

    // Check if user has at least one of the required roles
    const hasRole = requiredRoles.some((role) => userRoles.includes(role));

    if (!hasRole) {
      throw new ForbiddenException(`Access denied. Required roles: ${requiredRoles.join(", ")}`);
    }

    return true;
  }
}
