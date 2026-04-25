export type { ClientType, RoleName } from "./auth.const";

import type { ClientType, RoleName } from "./auth.const";

/**
 * Parameters for validating role against client type and origin.
 */
export interface ValidateRoleForClientParams {
  role: RoleName;
  origin: string | null;
  clientType: ClientType | null;
  referer?: string | null;
}
