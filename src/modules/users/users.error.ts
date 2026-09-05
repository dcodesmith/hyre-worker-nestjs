import { HttpStatus } from "@nestjs/common";
import { AppException } from "../../common/errors/app.exception";

export const UsersErrorCode = {
  USERS_STAFF_ROLE_CONFLICT: "USERS_STAFF_ROLE_CONFLICT",
  USERS_USER_NOT_FOUND: "USERS_USER_NOT_FOUND",
} as const;

export class UsersException extends AppException {}

export class UsersStaffRoleConflictException extends UsersException {
  constructor() {
    super(
      UsersErrorCode.USERS_STAFF_ROLE_CONFLICT,
      "Staff cannot also be an admin, fleet owner, or chauffeur",
      HttpStatus.CONFLICT,
      {
        type: UsersErrorCode.USERS_STAFF_ROLE_CONFLICT,
        title: "Staff Role Conflict",
      },
    );
  }
}

export class UsersUserNotFoundException extends UsersException {
  constructor() {
    super(UsersErrorCode.USERS_USER_NOT_FOUND, "User not found", HttpStatus.NOT_FOUND, {
      type: UsersErrorCode.USERS_USER_NOT_FOUND,
      title: "User Not Found",
    });
  }
}
