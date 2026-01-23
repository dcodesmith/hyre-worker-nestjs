import { SetMetadata } from "@nestjs/common";
import type { RoleName } from "../auth.types";

export const ROLES_KEY = "roles";

/**
 * Decorator to specify which roles are allowed to access a route.
 *
 * Must be used with RoleGuard to enforce the role requirement.
 * RoleGuard must be used AFTER SessionGuard to ensure the session is validated first.
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
 * @param roles - One or more role names that are allowed to access the route
 */
export const Roles = (...roles: RoleName[]) => SetMetadata(ROLES_KEY, roles);
