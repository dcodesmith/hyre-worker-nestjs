import { AuthErrorCode, AuthServiceUnavailableException } from "../auth.error";

type GetSessionMock = (...args: unknown[]) => unknown;
type GetUserRolesMock = (...args: unknown[]) => unknown;

interface CreateMockAuthServiceParams {
  isInitialized: boolean;
  getSessionMock: GetSessionMock;
  getUserRolesMock: GetUserRolesMock;
}

export function createMockAuthService({
  isInitialized,
  getSessionMock,
  getUserRolesMock,
}: CreateMockAuthServiceParams) {
  const initializedAuthService = {
    isInitialized,
    auth: {
      api: {
        getSession: getSessionMock,
      },
    },
    getUserRoles: getUserRolesMock,
  };

  if (isInitialized) {
    return initializedAuthService;
  }

  return {
    isInitialized,
    get auth() {
      throw new AuthServiceUnavailableException(
        AuthErrorCode.AUTH_SERVICE_NOT_CONFIGURED,
        "Authentication service is not configured. Contact support.",
        "Authentication Service Not Configured",
      );
    },
    getUserRoles: getUserRolesMock,
  };
}
