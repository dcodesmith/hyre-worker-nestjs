import { HttpStatus } from "@nestjs/common";
import { AppException } from "../../common/errors/app.exception";

export const AuthErrorCode = {
  AUTH_SERVICE_NOT_CONFIGURED: "AUTH_SERVICE_NOT_CONFIGURED",
  AUTH_NOT_AUTHENTICATED: "AUTH_NOT_AUTHENTICATED",
  AUTH_INVALID_OR_EXPIRED_SESSION: "AUTH_INVALID_OR_EXPIRED_SESSION",
  AUTH_PROTECTED_ROLE_ASSIGNMENT_DENIED: "AUTH_PROTECTED_ROLE_ASSIGNMENT_DENIED",
  AUTH_INVALID_ROLE: "AUTH_INVALID_ROLE",
  AUTH_USER_NOT_FOUND_FOR_ROLE_ASSIGNMENT: "AUTH_USER_NOT_FOUND_FOR_ROLE_ASSIGNMENT",
  AUTH_ROLE_REQUIREMENT_FAILED: "AUTH_ROLE_REQUIREMENT_FAILED",
  AUTH_SESSION_NOT_FOUND: "AUTH_SESSION_NOT_FOUND",
  AUTH_INSUFFICIENT_ROLE: "AUTH_INSUFFICIENT_ROLE",
} as const;

export type AuthErrorCodeValue = (typeof AuthErrorCode)[keyof typeof AuthErrorCode];

export class AuthException extends AppException {}

export class AuthServiceUnavailableException extends AuthException {
  constructor(errorCode: AuthErrorCodeValue, detail: string, title: string) {
    super(errorCode, detail, HttpStatus.SERVICE_UNAVAILABLE, { title });
  }
}

export class AuthUnauthorizedException extends AuthException {
  constructor(errorCode: AuthErrorCodeValue, detail: string, title: string) {
    super(errorCode, detail, HttpStatus.UNAUTHORIZED, { title });
  }
}

export class AuthForbiddenException extends AuthException {
  constructor(errorCode: AuthErrorCodeValue, detail: string, title: string) {
    super(errorCode, detail, HttpStatus.FORBIDDEN, { title });
  }
}

export class AuthNotFoundException extends AuthException {
  constructor(errorCode: AuthErrorCodeValue, detail: string, title: string) {
    super(errorCode, detail, HttpStatus.NOT_FOUND, { title });
  }
}
