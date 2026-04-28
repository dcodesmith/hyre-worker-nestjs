import { HttpStatus } from "@nestjs/common";
import { AppException } from "../../common/errors/app.exception";

export const EmailErrorCode = {
  EMAIL_DELIVERY_FAILED: "EMAIL_DELIVERY_FAILED",
  EMAIL_PROVIDER_RESPONSE_ERROR: "EMAIL_PROVIDER_RESPONSE_ERROR",
} as const;

export class EmailException extends AppException {}

export class EmailDeliveryFailedException extends EmailException {
  constructor(detail = "Failed to send email", details?: Record<string, unknown>) {
    super(EmailErrorCode.EMAIL_DELIVERY_FAILED, detail, HttpStatus.BAD_GATEWAY, {
      title: "Email Delivery Failed",
      details,
    });
  }
}

export class EmailProviderResponseException extends EmailException {
  constructor(provider: "resend" | "smtp", details?: Record<string, unknown>) {
    super(
      EmailErrorCode.EMAIL_PROVIDER_RESPONSE_ERROR,
      `Email provider '${provider}' returned an error response`,
      HttpStatus.BAD_GATEWAY,
      { title: "Email Provider Error", details },
    );
  }
}
