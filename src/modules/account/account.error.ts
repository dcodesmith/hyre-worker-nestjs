import { HttpStatus } from "@nestjs/common";
import { AppException } from "../../common/errors/app.exception";

export const AccountErrorCode = {
  ACCOUNT_USER_NOT_FOUND: "ACCOUNT_USER_NOT_FOUND",
  ACCOUNT_DELETE_FAILED: "ACCOUNT_DELETE_FAILED",
} as const;

export class AccountException extends AppException {}

export class AccountUserNotFoundException extends AccountException {
  constructor() {
    super(AccountErrorCode.ACCOUNT_USER_NOT_FOUND, "User not found", HttpStatus.NOT_FOUND, {
      type: AccountErrorCode.ACCOUNT_USER_NOT_FOUND,
      title: "User Not Found",
    });
  }
}

export class AccountDeleteFailedException extends AccountException {
  constructor() {
    super(
      AccountErrorCode.ACCOUNT_DELETE_FAILED,
      "Failed to delete account",
      HttpStatus.INTERNAL_SERVER_ERROR,
      {
        type: AccountErrorCode.ACCOUNT_DELETE_FAILED,
        title: "Account Deletion Failed",
      },
    );
  }
}
