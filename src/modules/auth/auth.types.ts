/**
 * Role and client type definitions for role-based authentication.
 *
 * These types are used by Better Auth hooks to validate and assign roles
 * during the OTP authentication flow.
 */

// ============================================================================
// Role Constants
// ============================================================================

/** Regular customer (can self-register) */
export const USER = "user" as const;

/** Vehicle fleet owner (can self-register) */
export const FLEET_OWNER = "fleetOwner" as const;

/** Administrator (must be pre-assigned) */
export const ADMIN = "admin" as const;

/** Staff member (must be pre-assigned) */
export const STAFF = "staff" as const;

/** All valid role names */
export const ROLE_NAMES = [USER, FLEET_OWNER, ADMIN, STAFF] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

// ============================================================================
// Client Type Constants
// ============================================================================

/** Browser-based client (uses Origin header) */
export const WEB = "web" as const;

/** Mobile app client (uses X-Client-Type header) */
export const MOBILE = "mobile" as const;

/** All valid client types */
export const CLIENT_TYPES = [WEB, MOBILE] as const;
export type ClientType = (typeof CLIENT_TYPES)[number];

// ============================================================================
// Role Categories
// ============================================================================

/**
 * Roles that can be auto-granted on registration.
 * These are "safe" roles that anyone can obtain through self-signup.
 */
export const GRANTABLE_ROLES = [USER, FLEET_OWNER] as const;

/**
 * Roles that require pre-existing assignment (cannot be auto-granted).
 * These are privileged roles that must be assigned by an admin.
 */
export const PROTECTED_ROLES = [ADMIN, STAFF] as const;

/**
 * Type guard to validate if a value is a valid RoleName.
 */
export function isValidRole(role: unknown): role is RoleName {
  return typeof role === "string" && ROLE_NAMES.includes(role as RoleName);
}

/**
 * Type guard to validate if a value is a valid ClientType.
 */
export function isValidClientType(clientType: unknown): clientType is ClientType {
  return typeof clientType === "string" && CLIENT_TYPES.includes(clientType as ClientType);
}

/**
 * Check if a role can be auto-granted during registration.
 */
export function isGrantableRole(role: RoleName): boolean {
  return (GRANTABLE_ROLES as readonly RoleName[]).includes(role);
}

/**
 * Check if a role is protected (requires pre-assignment).
 */
export function isProtectedRole(role: RoleName): boolean {
  return (PROTECTED_ROLES as readonly RoleName[]).includes(role);
}

/**
 * Parameters for validating role against client type and origin.
 */
export interface ValidateRoleForClientParams {
  role: RoleName;
  origin: string | null;
  clientType: ClientType | null;
  referer?: string | null;
}
