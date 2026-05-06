import { HttpStatus } from "@nestjs/common";
import { AppException } from "../../common/errors/app.exception";

export const NotificationErrorCode = {
  PUSH_TOKEN_OWNERSHIP_CONFLICT: "PUSH_TOKEN_OWNERSHIP_CONFLICT",
} as const;

export class NotificationException extends AppException {}

export class PushTokenOwnershipConflictException extends NotificationException {
  constructor() {
    super(
      NotificationErrorCode.PUSH_TOKEN_OWNERSHIP_CONFLICT,
      "Push token is already registered to another user",
      HttpStatus.CONFLICT,
      { title: "Push Token Ownership Conflict" },
    );
  }
}
