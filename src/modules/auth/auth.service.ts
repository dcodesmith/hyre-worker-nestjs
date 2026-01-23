import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { EnvConfig } from "../../config/env.config";
import { DatabaseService } from "../database/database.service";
import { type Auth, createAuth } from "./auth.config";
import {
  ADMIN,
  FLEET_OWNER,
  GRANTABLE_ROLES,
  MOBILE,
  PROTECTED_ROLES,
  type RoleName,
  STAFF,
  USER,
  type ValidateRoleForClientParams,
} from "./auth.types";
import { AuthEmailService } from "./auth-email.service";

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);
  private _auth: Auth | null = null;
  private trustedOrigins: string[] = [];

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly configService: ConfigService<EnvConfig>,
    private readonly authEmailService: AuthEmailService,
  ) {}

  onModuleInit() {
    const sessionSecret = this.configService.get("SESSION_SECRET", { infer: true });
    const authBaseUrl = this.configService.get("AUTH_BASE_URL", { infer: true });
    const trustedOrigins = this.configService.get("TRUSTED_ORIGINS", { infer: true });
    const nodeEnv = this.configService.get("NODE_ENV", { infer: true });

    if (!sessionSecret || !authBaseUrl || !trustedOrigins?.length) {
      this.logger.warn(
        "Auth configuration incomplete. AuthService will not be initialized. " +
          "Set SESSION_SECRET, AUTH_BASE_URL, and TRUSTED_ORIGINS to enable auth.",
      );
      return;
    }

    this.trustedOrigins = trustedOrigins;

    this._auth = createAuth({
      prisma: this.databaseService,
      sessionSecret,
      authBaseUrl,
      trustedOrigins,
      secureCookies: nodeEnv !== "development",
      enableRateLimit: true,
      sendOTPEmail: this.authEmailService.sendOTPEmail.bind(this.authEmailService),
      roleValidation: {
        validateRoleForClient: this.validateRoleForClient.bind(this),
        validateExistingUserRole: this.validateExistingUserRole.bind(this),
        assignRoleToNewUser: this.assignRoleToNewUser.bind(this),
      },
    });

    this.logger.log("Auth service initialized successfully");
  }

  get auth(): Auth {
    if (!this._auth) {
      throw new Error(
        "Auth service not initialized. Ensure SESSION_SECRET, AUTH_BASE_URL, and TRUSTED_ORIGINS are configured.",
      );
    }
    return this._auth;
  }

  get isInitialized(): boolean {
    return this._auth !== null;
  }

  /**
   * Validates that a role is allowed for the given client type and origin.
   *
   * SECURITY NOTE: This method only controls which roles can be REQUESTED from
   * a given entry point. It does NOT grant authorization. Protected roles (admin, staff)
   * still require the user to already have the role in the database - this is enforced
   * by validateExistingUserRole() in the before hook.
   *
   * Rules:
   * - Mobile clients can only request "user" role
   * - Web clients must have an Origin header from a TRUSTED_ORIGINS source
   * - Web clients accessing /admin/* can request "admin" or "staff"
   * - Web clients accessing /fleet-owner/* can request "fleetOwner"
   * - Web clients accessing /auth (default) can only request "user"
   */
  validateRoleForClient({
    role,
    origin,
    clientType,
    referer,
  }: ValidateRoleForClientParams): boolean {
    // Mobile app: only user role allowed
    if (clientType === MOBILE) {
      return role === USER;
    }

    // Web app: must have Origin header from a trusted source
    if (!origin) {
      // No origin and not mobile = reject for security
      return false;
    }

    // Validate origin is in the trusted origins list
    if (!this.isTrustedOrigin(origin)) {
      return false;
    }

    // Safely extract pathname from referer or origin
    const pathname = this.extractPathname(referer) || this.extractPathname(origin) || "";

    // Admin portal: admin and staff roles only
    // Enforce segment boundary: exact match or subtree with trailing slash
    if (pathname === "/admin" || pathname.startsWith("/admin/")) {
      return role === ADMIN || role === STAFF;
    }

    // Fleet owner portal: fleetOwner role only
    // Enforce segment boundary: exact match or subtree with trailing slash
    if (pathname === "/fleet-owner" || pathname.startsWith("/fleet-owner/")) {
      return role === FLEET_OWNER;
    }

    // Default public auth: user role only
    return role === USER;
  }

  /**
   * Safely extracts the pathname from a URL string.
   * Returns null if the URL is invalid or empty.
   *
   * SECURITY NOTE: This method normalizes path traversal sequences (e.g., /admin/../user)
   * to prevent bypassing pathname-based role validation.
   */
  private extractPathname(urlString: string | null | undefined): string | null {
    if (!urlString) {
      return null;
    }

    try {
      const url = new URL(urlString);
      return url.pathname;
    } catch {
      // Invalid URL - could be a path-only string or malformed
      // If it looks like a path (starts with /), normalize it using URL with a dummy base
      if (urlString.startsWith("/")) {
        try {
          // Use URL constructor with dummy base to normalize path traversal sequences
          const normalizedUrl = new URL(urlString, "http://localhost");
          return normalizedUrl.pathname;
        } catch {
          // If normalization fails, reject the path for security
          return null;
        }
      }
      return null;
    }
  }

  /**
   * Validates that the provided origin is in the trusted origins list.
   * Compares the full origin (protocol://host:port) for security.
   *
   * @param origin - The origin header value to validate
   * @returns true if the origin is trusted, false otherwise
   */
  private isTrustedOrigin(origin: string): boolean {
    try {
      const originUrl = new URL(origin);
      const originBase = originUrl.origin; // Gets protocol://host:port

      return this.trustedOrigins.some((trusted) => {
        try {
          const trustedUrl = new URL(trusted);
          return trustedUrl.origin === originBase;
        } catch {
          return false;
        }
      });
    } catch {
      // Invalid origin URL
      return false;
    }
  }

  /**
   * Validates that an existing user has the requested role.
   * For new users (not found), only allows grantable roles (user, fleetOwner).
   * Protected roles (admin, staff) require the user to already exist with that role.
   *
   * @param email - User's email address
   * @param role - Role being requested
   * @returns true if new user with grantable role, or existing user has the role
   */
  async validateExistingUserRole(email: string, role: RoleName): Promise<boolean> {
    const user = await this.databaseService.user.findUnique({
      where: { email },
      include: { roles: { select: { name: true } } },
    });

    // New user - only allow grantable roles (user, fleetOwner)
    // Protected roles (admin, staff) require existing user with that role
    if (!user) {
      return (GRANTABLE_ROLES as readonly RoleName[]).includes(role);
    }

    // Existing user - must have the role
    return user.roles.some((r) => r.name === role);
  }

  /**
   * Assigns a role to a newly created user (called from databaseHooks.user.create.after).
   * Only handles grantable roles since protected roles cannot be self-assigned.
   *
   * @param userId - User's ID
   * @param role - Role to assign
   * @throws UnauthorizedException if role is not grantable
   */
  async assignRoleToNewUser(userId: string, role: RoleName): Promise<void> {
    if ((GRANTABLE_ROLES as readonly RoleName[]).includes(role)) {
      // Grantable roles: auto-grant to new user
      await this.ensureUserHasRole(userId, role);
    } else if ((PROTECTED_ROLES as readonly RoleName[]).includes(role)) {
      // Protected roles cannot be assigned to new users
      // The before hook should prevent this, but this is a safety check
      throw new UnauthorizedException(`Protected role "${role}" cannot be assigned to new users`);
    } else {
      throw new UnauthorizedException(`Invalid role: ${role}`);
    }
  }

  /**
   * Ensures a user has a specific role, granting it if missing.
   * Used for self-signup roles like "user" and "fleetOwner".
   *
   * @param userId - User's ID
   * @param role - Role to ensure
   */
  async ensureUserHasRole(userId: string, role: RoleName): Promise<void> {
    const user = await this.databaseService.user.findUnique({
      where: { id: userId },
      include: { roles: { select: { name: true } } },
    });

    if (!user) {
      this.logger.warn(`Cannot assign role: user ${userId} not found`);
      throw new NotFoundException(`Cannot assign role: user ${userId} not found`);
    }

    const hasRole = user.roles.some((r) => r.name === role);

    if (!hasRole) {
      await this.databaseService.user.update({
        where: { id: userId },
        data: { roles: { connect: { name: role } } },
      });
      this.logger.log(`Assigned role "${role}" to user ${userId}`);
    }
  }

  /**
   * Verifies that a user has a specific role.
   * Used for protected roles like "admin" and "staff" that cannot be self-assigned.
   *
   * @param userId - User's ID
   * @param role - Role to verify
   * @throws UnauthorizedException if user doesn't have the role
   */
  async verifyUserHasRole(userId: string, role: RoleName): Promise<void> {
    const user = await this.databaseService.user.findUnique({
      where: { id: userId },
      include: { roles: { select: { name: true } } },
    });

    const hasRole = user?.roles.some((r) => r.name === role) ?? false;

    if (!hasRole) {
      this.logger.warn(`User ${userId} does not have required role: ${role}`);
      throw new UnauthorizedException(`User does not have required role: ${role}`);
    }
  }
}
