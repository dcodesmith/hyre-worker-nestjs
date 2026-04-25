/**
 * Role and client type declarations for role-based authentication.
 */
export type RoleName = "user" | "fleetOwner" | "admin" | "staff";

export type ClientType = "web" | "mobile";

/**
 * Parameters for validating role against client type and origin.
 */
export interface ValidateRoleForClientParams {
  role: RoleName;
  origin: string | null;
  clientType: ClientType | null;
  referer?: string | null;
}
