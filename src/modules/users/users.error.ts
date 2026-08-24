import { HttpStatus } from "@nestjs/common";
import { AppException } from "../../common/errors/app.exception";

export const UsersErrorCode = {
  USERS_USER_NOT_FOUND: "USERS_USER_NOT_FOUND",
} as const;

export class UsersException extends AppException {}

export class UsersUserNotFoundException extends UsersException {
  constructor() {
    super(UsersErrorCode.USERS_USER_NOT_FOUND, "User not found", HttpStatus.NOT_FOUND, {
      type: UsersErrorCode.USERS_USER_NOT_FOUND,
      title: "User Not Found",
    });
  }
}
