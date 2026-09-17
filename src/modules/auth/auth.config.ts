import type { PrismaClient } from "@prisma/client";
import { APIError, betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { createAuthMiddleware } from "better-auth/api";
import { bearer, emailOTP } from "better-auth/plugins";
import { v7 as uuidv7 } from "uuid";
import { isValidRole, MOBILE, USER } from "./auth.const";
import type { ClientType, RoleName, ValidateRoleForClientParams } from "./auth.interface";

export const generateAuthId = (): string => uuidv7();

export type ReferralSignupValidation =
  | { referrerUserId: string; referralCode: string }
  | { programInactive: true }
  | null;

/**
 * Role validation callbacks that integrate with AuthService methods.
 * These are injected by AuthService to allow hooks to use NestJS services.
 */
export interface RoleValidationCallbacks {
  /** Validates that a role is allowed for the given client type and origin */
  validateRoleForClient: (params: ValidateRoleForClientParams) => boolean;
  /** Validates that an existing user has the requested role */
  validateExistingUserRole: (email: string, role: RoleName) => Promise<boolean>;
  /** Checks whether an email already belongs to a user */
  isExistingUser: (email: string) => Promise<boolean>;
  /** Assigns a role to a newly created user (called from databaseHooks.user.create.after) */
  assignRoleToNewUser: (userId: string, role: RoleName) => Promise<void>;
  /** Generates and stores a referral code for a newly created user */
  assignReferralCodeToNewUser: (userId: string) => Promise<string>;
  /** Validates a referral code and returns the referrer user ID for new user attribution */
  validateReferralCodeForSignup: (code: string, email: string) => Promise<ReferralSignupValidation>;
  /** Persists referral attribution while the user completes OTP verification */
  savePendingReferralForSignup: (
    email: string,
    attribution: { referrerUserId: string; referralCode: string },
    expiresAt: Date,
  ) => Promise<void>;
  /** Clears referral attribution when an OTP is requested without a referral code */
  clearPendingReferralForSignup: (email: string) => Promise<void>;
  /** Consumes persisted referral attribution after successful OTP authentication */
  assignPendingReferralToNewUser: (userId: string, email: string) => Promise<void>;
  /** Gets all roles for a user (used by after hook to enrich sign-in response) */
  getUserRoles: (userId: string) => Promise<RoleName[]>;
  /** Claims guest bookings after the account email has been verified by sign-in */
  claimGuestBookingsForUser: (userId: string) => Promise<void>;
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
const EMAIL_OTP_EXPIRY_SECONDS = 600;

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
const REFERRAL_CAPTURE_PATH = "/email-otp/send-verification-otp";

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

function extractReferralCode(body: unknown): string | undefined {
  if (body && typeof body === "object" && "referralCode" in body) {
    const referralCode = (body as { referralCode: unknown }).referralCode;
    return typeof referralCode === "string" ? referralCode.trim().toUpperCase() : undefined;
  }
  return undefined;
}

async function capturePendingReferral({
  path,
  email,
  body,
  callbacks,
}: {
  path: string;
  email: string;
  body: unknown;
  callbacks: RoleValidationCallbacks;
}): Promise<void> {
  if (path !== REFERRAL_CAPTURE_PATH) {
    return;
  }

  const referralCode = extractReferralCode(body);
  await callbacks.clearPendingReferralForSignup(email);
  if (!referralCode || (await callbacks.isExistingUser(email))) {
    return;
  }

  const attribution = await callbacks.validateReferralCodeForSignup(referralCode, email);
  if (!attribution) {
    throw new APIError("BAD_REQUEST", {
      message: "Invalid referral code",
    });
  }
  if ("programInactive" in attribution) {
    throw new APIError("BAD_REQUEST", {
      message: "Referral programme is not active",
    });
  }

  await callbacks.savePendingReferralForSignup(
    email,
    attribution,
    new Date(Date.now() + EMAIL_OTP_EXPIRY_SECONDS * 1000),
  );
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
          await capturePendingReferral({
            path,
            email,
            body: ctx.body,
            callbacks: roleValidation,
          });
        }
      })
    : undefined;

  /**
   * Creates a plugin to enrich sign-in response with user roles.
   * This uses Better Auth's plugin hooks system to intercept and modify
   * the sign-in response after successful authentication.
   */
  const roleEnrichmentPlugin = roleValidation
    ? {
        id: "role-enrichment",
        hooks: {
          after: [
            {
              matcher: (context) => context.path === "/sign-in/email-otp",
              handler: createAuthMiddleware(async (ctx) => {
                // Get the response from the context - it's already the parsed body, not a Response
                const returned = ctx.context.returned as
                  | { user?: { id?: string; email?: string }; token?: string }
                  | Error
                  | undefined;

                // Skip if no returned value or if it's an error
                if (!returned || returned instanceof Error) {
                  return;
                }

                // Check if response contains user data (successful sign-in)
                if (!returned.user?.id || !returned.user.email) {
                  return;
                }

                await roleValidation.assignPendingReferralToNewUser(
                  returned.user.id,
                  returned.user.email,
                );
                await roleValidation.claimGuestBookingsForUser(returned.user.id);

                // Fetch roles for the user
                const roles = await roleValidation.getUserRoles(returned.user.id);

                // Enrich user object with roles and return using ctx.json
                return ctx.json({
                  ...returned,
                  user: {
                    ...returned.user,
                    roles,
                  },
                });
              }),
            },
          ],
        },
      }
    : null;

  return betterAuth({
    database: prismaAdapter(prisma, { provider: "postgresql" }),
    secret: sessionSecret,
    baseURL: authBaseUrl,
    basePath: "/api/auth",
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
                await roleValidation.assignReferralCodeToNewUser(user.id);
              },
            },
          },
        }
      : undefined,
    plugins: [
      emailOTP({
        expiresIn: EMAIL_OTP_EXPIRY_SECONDS,
        otpLength: 6,
        async sendVerificationOTP({ email, otp }) {
          await sendOTPEmail(email, otp);
        },
      }),
      bearer(),
      ...(roleEnrichmentPlugin ? [roleEnrichmentPlugin] : []),
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
      database: {
        generateId: generateAuthId,
      },
      // Use __Host- prefix in production for enhanced security (prevents subdomain attacks)
      // In development, use no prefix since __Host- requires HTTPS
      cookiePrefix: secureCookies ? "__Host-" : "",
      defaultCookieAttributes: {
        httpOnly: true,
        secure: secureCookies,
        sameSite: "lax",
        // __Host- cookies require path to be "/"
        ...(secureCookies && { path: "/" }),
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
