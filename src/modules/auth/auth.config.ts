import type { PrismaClient } from "@prisma/client";
import { APIError, betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { createAuthMiddleware } from "better-auth/api";
import { bearer, emailOTP } from "better-auth/plugins";
import {
  type ClientType,
  isValidRole,
  MOBILE,
  type RoleName,
  USER,
  type ValidateRoleForClientParams,
} from "./auth.types";

/**
 * Role validation callbacks that integrate with AuthService methods.
 * These are injected by AuthService to allow hooks to use NestJS services.
 */
export interface RoleValidationCallbacks {
  /** Validates that a role is allowed for the given client type and origin */
  validateRoleForClient: (params: ValidateRoleForClientParams) => boolean;
  /** Validates that an existing user has the requested role */
  validateExistingUserRole: (email: string, role: RoleName) => Promise<boolean>;
  /** Assigns a role to a newly created user (called from databaseHooks.user.create.after) */
  assignRoleToNewUser: (userId: string, role: RoleName) => Promise<void>;
}

/**
 * In-memory cache for pending role assignments.
 *
 * This cache bridges the gap between the before hook and database hook:
 * - Before hook has access to full request body (including custom 'role' field)
 * - Database hook only receives validated body (Better Auth strips unknown fields)
 *
 * Flow:
 * 1. Before hook validates role and stores: setPendingRole(email, role)
 * 2. User is created by Better Auth
 * 3. Database hook retrieves and deletes: consumePendingRole(email)
 *
 * TTL cleanup prevents memory leaks from abandoned OTP flows.
 */
const pendingRoles = new Map<string, { role: RoleName; timestamp: number }>();
const PENDING_ROLE_TTL_MS = 10 * 60 * 1000; // 10 minutes (matches OTP expiry)

/**
 * Cleans up expired pending role entries to prevent memory leaks.
 */
function cleanupExpiredPendingRoles(): void {
  const now = Date.now();
  for (const [email, entry] of pendingRoles) {
    if (now - entry.timestamp > PENDING_ROLE_TTL_MS) {
      pendingRoles.delete(email);
    }
  }
}

/**
 * Stores a pending role for an email address.
 * Called from the before hook after successful validation.
 */
function setPendingRole(email: string, role: RoleName): void {
  // Clean up old entries periodically to prevent unbounded growth
  if (pendingRoles.size > 100) {
    cleanupExpiredPendingRoles();
  }
  pendingRoles.set(email, { role, timestamp: Date.now() });
}

/**
 * Retrieves and removes the pending role for an email address.
 * Called from the database hook when a new user is created.
 * Returns USER as default if no valid pending role exists.
 */
function consumePendingRole(email: string): RoleName {
  const entry = pendingRoles.get(email);
  if (entry) {
    pendingRoles.delete(email);
    // Only return role if not expired
    if (Date.now() - entry.timestamp <= PENDING_ROLE_TTL_MS) {
      return entry.role;
    }
  }
  return USER;
}

export interface AuthConfigOptions {
  prisma: PrismaClient;
  sessionSecret: string;
  authBaseUrl: string;
  trustedOrigins: string[];
  sendOTPEmail: (email: string, otp: string) => Promise<void>;
  secureCookies: boolean;
  enableRateLimit: boolean;
  /** Optional role validation callbacks for hooks */
  roleValidation?: RoleValidationCallbacks;
}

/**
 * Paths that require role validation before processing.
 */
const ROLE_VALIDATED_PATHS = [
  "/email-otp/send-verification-otp",
  "/email-otp/verify-email",
  "/sign-in/email-otp",
] as const;

/**
 * Safely extracts email from an unknown body type.
 */
function extractEmail(body: unknown): string | undefined {
  if (body && typeof body === "object" && "email" in body) {
    const email = (body as { email: unknown }).email;
    return typeof email === "string" ? email : undefined;
  }
  return undefined;
}

/**
 * Safely extracts role from an unknown body type.
 */
function extractRole(body: unknown): unknown {
  if (body && typeof body === "object" && "role" in body) {
    return (body as { role: unknown }).role;
  }
  return undefined;
}

/**
 * Extracts role validation parameters from a Better Auth request context.
 */
function extractRoleParams(ctx: { request?: Request; body?: unknown }): {
  role: RoleName;
  clientType: ClientType | null;
  origin: string | null;
  referer: string | null;
} {
  const request = ctx.request;
  const bodyRole = extractRole(ctx.body);

  // Determine role from body, defaulting to USER
  const role: RoleName = isValidRole(bodyRole) ? bodyRole : USER;

  // Determine client type from headers
  const clientTypeHeader = request?.headers.get("x-client-type");
  const clientType: ClientType | null = clientTypeHeader === MOBILE ? MOBILE : null;

  // Get origin and referer for web client validation
  const origin = request?.headers.get("origin") ?? null;
  const referer = request?.headers.get("referer") ?? null;

  return { role, clientType, origin, referer };
}

export function createAuth(options: AuthConfigOptions) {
  const {
    prisma,
    sessionSecret,
    authBaseUrl,
    trustedOrigins,
    sendOTPEmail,
    secureCookies,
    enableRateLimit,
    roleValidation,
  } = options;

  // Create before hook middleware for role validation
  const beforeHook = roleValidation
    ? createAuthMiddleware(async (ctx) => {
        const path = ctx.path;

        // Only validate paths that require role validation
        if (!ROLE_VALIDATED_PATHS.includes(path as (typeof ROLE_VALIDATED_PATHS)[number])) {
          return;
        }

        const { role, clientType, origin, referer } = extractRoleParams(ctx);
        const email = extractEmail(ctx.body);

        // Validate role is allowed for this client type/origin
        if (!roleValidation.validateRoleForClient({ role, clientType, origin, referer })) {
          throw new APIError("FORBIDDEN", {
            message: `Role "${role}" is not allowed from this client`,
          });
        }

        // Validate user can use this role:
        // - New users can only request grantable roles (user, fleetOwner)
        // - Existing users must already have the requested role
        if (email) {
          const isValid = await roleValidation.validateExistingUserRole(email, role);
          if (!isValid) {
            throw new APIError("FORBIDDEN", {
              message: `User does not have the "${role}" role`,
            });
          }

          // Store the validated role for the database hook to retrieve later.
          // This is necessary because Better Auth's email-otp plugin strips
          // custom fields (like 'role') from the request body during validation.
          setPendingRole(email, role);
        }
      })
    : undefined;

  return betterAuth({
    database: prismaAdapter(prisma, { provider: "postgresql" }),
    secret: sessionSecret,
    baseURL: authBaseUrl,
    basePath: "/auth/api",
    trustedOrigins,
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      cookieCache: {
        enabled: true,
        maxAge: 60 * 5, // 5 minutes
      },
    },
    hooks: beforeHook
      ? {
          before: beforeHook,
        }
      : undefined,
    databaseHooks: roleValidation
      ? {
          user: {
            create: {
              async after(user) {
                // Retrieve the role that was stored by the before hook.
                // Better Auth's email-otp plugin strips custom fields from the body,
                // so we use the pendingRoles cache to pass the role between hooks.
                const role = consumePendingRole(user.email);

                // Assign the role to the newly created user
                // Protected roles were already rejected in the before hook via validateExistingUserRole()
                await roleValidation.assignRoleToNewUser(user.id, role);
              },
            },
          },
        }
      : undefined,
    plugins: [
      emailOTP({
        expiresIn: 600, // 10 minutes
        otpLength: 6,
        async sendVerificationOTP({ email, otp }) {
          await sendOTPEmail(email, otp);
        },
      }),
      bearer(),
    ],
    rateLimit: {
      enabled: enableRateLimit,
      window: 60,
      max: 100,
      storage: "database",
      customRules: {
        "/email-otp/send-verification-otp": { window: 60, max: 5 },
        "/email-otp/check-verification-otp": { window: 60, max: 10 },
      },
    },
    advanced: {
      cookiePrefix: "", // Web app handles __Host- prefix
      defaultCookieAttributes: {
        httpOnly: true,
        secure: secureCookies,
        sameSite: "lax",
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
