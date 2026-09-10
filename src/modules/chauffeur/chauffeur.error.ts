import { HttpStatus } from "@nestjs/common";
import { AppException } from "../../common/errors/app.exception";

export const ChauffeurErrorCode = {
  INVITATION_NOT_ALLOWED: "CHAUFFEUR_INVITATION_NOT_ALLOWED",
  INVITATION_EXISTS: "CHAUFFEUR_INVITATION_EXISTS",
  INVITATION_INVALID: "CHAUFFEUR_INVITATION_INVALID",
  SESSION_INVALID: "CHAUFFEUR_SESSION_INVALID",
  IDEMPOTENCY_KEY_REUSED: "CHAUFFEUR_IDEMPOTENCY_KEY_REUSED",
  REQUEST_IN_PROGRESS: "CHAUFFEUR_VERIFICATION_IN_PROGRESS",
  STEP_INCOMPLETE: "CHAUFFEUR_VERIFICATION_STEP_INCOMPLETE",
  PHONE_CODE_INVALID: "CHAUFFEUR_PHONE_CODE_INVALID",
  PHONE_PROVIDER_UNAVAILABLE: "CHAUFFEUR_PHONE_PROVIDER_UNAVAILABLE",
  NIN_NOT_VERIFIED: "CHAUFFEUR_NIN_NOT_VERIFIED",
  LICENSE_NOT_VERIFIED: "CHAUFFEUR_LICENSE_NOT_VERIFIED",
  LICENSE_EXPIRED: "CHAUFFEUR_LICENSE_EXPIRED",
  MINIMUM_AGE_NOT_MET: "CHAUFFEUR_MINIMUM_AGE_NOT_MET",
  IDENTITY_MISMATCH: "CHAUFFEUR_IDENTITY_MISMATCH",
  BIOMETRIC_NOT_VERIFIED: "CHAUFFEUR_BIOMETRIC_NOT_VERIFIED",
  PROVIDER_UNAVAILABLE: "CHAUFFEUR_VERIFICATION_PROVIDER_UNAVAILABLE",
  ACCOUNT_CONFLICT: "CHAUFFEUR_ACCOUNT_CONFLICT",
  NOT_FOUND: "CHAUFFEUR_NOT_FOUND",
  OPERATION_FAILED: "CHAUFFEUR_OPERATION_FAILED",
} as const;

export class ChauffeurException extends AppException {}

export class ChauffeurInvitationNotAllowedException extends ChauffeurException {
  constructor() {
    super(
      ChauffeurErrorCode.INVITATION_NOT_ALLOWED,
      "Owner-drivers cannot invite another chauffeur",
      HttpStatus.CONFLICT,
      { title: "Chauffeur Invitation Not Allowed" },
    );
  }
}

export class ChauffeurInvitationExistsException extends ChauffeurException {
  constructor() {
    super(
      ChauffeurErrorCode.INVITATION_EXISTS,
      "This chauffeur has already been invited by this fleet owner",
      HttpStatus.CONFLICT,
      { title: "Chauffeur Invitation Already Exists" },
    );
  }
}

export class ChauffeurInvitationInvalidException extends ChauffeurException {
  constructor() {
    super(
      ChauffeurErrorCode.INVITATION_INVALID,
      "This chauffeur invitation is invalid, expired, or already used",
      HttpStatus.GONE,
      { title: "Chauffeur Invitation Unavailable" },
    );
  }
}

export class ChauffeurSessionInvalidException extends ChauffeurException {
  constructor() {
    super(
      ChauffeurErrorCode.SESSION_INVALID,
      "This chauffeur onboarding session is invalid or expired",
      HttpStatus.UNAUTHORIZED,
      { title: "Chauffeur Session Invalid" },
    );
  }
}

export class ChauffeurIdempotencyKeyReusedException extends ChauffeurException {
  constructor() {
    super(
      ChauffeurErrorCode.IDEMPOTENCY_KEY_REUSED,
      "This Idempotency-Key was already used with different chauffeur details",
      HttpStatus.CONFLICT,
      { title: "Idempotency Key Reused" },
    );
  }
}

export class ChauffeurRequestInProgressException extends ChauffeurException {
  constructor(readonly retryAfterSeconds = 5) {
    super(
      ChauffeurErrorCode.REQUEST_IN_PROGRESS,
      "This chauffeur verification step is still being processed",
      HttpStatus.CONFLICT,
      {
        title: "Chauffeur Verification In Progress",
        details: { retryAfterSeconds },
      },
    );
  }
}

export class ChauffeurStepIncompleteException extends ChauffeurException {
  constructor(step: "CONSENT" | "PHONE" | "NIN") {
    super(
      ChauffeurErrorCode.STEP_INCOMPLETE,
      `Complete the ${step.toLowerCase()} step first`,
      HttpStatus.CONFLICT,
      { title: "Chauffeur Verification Step Incomplete", details: { requiredStep: step } },
    );
  }
}

export class ChauffeurPhoneCodeInvalidException extends ChauffeurException {
  constructor() {
    super(
      ChauffeurErrorCode.PHONE_CODE_INVALID,
      "The phone verification code is invalid or expired",
      HttpStatus.UNPROCESSABLE_ENTITY,
      { title: "Invalid Verification Code" },
    );
  }
}

export class ChauffeurPhoneProviderUnavailableException extends ChauffeurException {
  constructor() {
    super(
      ChauffeurErrorCode.PHONE_PROVIDER_UNAVAILABLE,
      "Phone verification is temporarily unavailable",
      HttpStatus.BAD_GATEWAY,
      { title: "Phone Verification Unavailable" },
    );
  }
}

export class ChauffeurNinNotVerifiedException extends ChauffeurException {
  constructor() {
    super(
      ChauffeurErrorCode.NIN_NOT_VERIFIED,
      "We could not verify this NIN. Check the number and try again.",
      HttpStatus.UNPROCESSABLE_ENTITY,
      { title: "NIN Not Verified" },
    );
  }
}

export class ChauffeurLicenseNotVerifiedException extends ChauffeurException {
  constructor() {
    super(
      ChauffeurErrorCode.LICENSE_NOT_VERIFIED,
      "We could not verify this driver's licence. Check the number and try again.",
      HttpStatus.UNPROCESSABLE_ENTITY,
      { title: "Driver's Licence Not Verified" },
    );
  }
}

export class ChauffeurLicenseExpiredException extends ChauffeurException {
  constructor() {
    super(
      ChauffeurErrorCode.LICENSE_EXPIRED,
      "This driver's licence has expired",
      HttpStatus.UNPROCESSABLE_ENTITY,
      { title: "Driver's Licence Expired" },
    );
  }
}

export class ChauffeurMinimumAgeException extends ChauffeurException {
  constructor() {
    super(
      ChauffeurErrorCode.MINIMUM_AGE_NOT_MET,
      "Chauffeurs must be at least 21 years old",
      HttpStatus.UNPROCESSABLE_ENTITY,
      { title: "Minimum Age Not Met" },
    );
  }
}

export class ChauffeurIdentityMismatchException extends ChauffeurException {
  constructor() {
    super(
      ChauffeurErrorCode.IDENTITY_MISMATCH,
      "The driver's licence identity does not match the verified NIN",
      HttpStatus.UNPROCESSABLE_ENTITY,
      { title: "Identity Mismatch" },
    );
  }
}

export class ChauffeurBiometricNotVerifiedException extends ChauffeurException {
  constructor() {
    super(
      ChauffeurErrorCode.BIOMETRIC_NOT_VERIFIED,
      "The selfie could not be matched to the driver's licence identity",
      HttpStatus.UNPROCESSABLE_ENTITY,
      { title: "Biometric Verification Failed" },
    );
  }
}

export class ChauffeurProviderUnavailableException extends ChauffeurException {
  constructor() {
    super(
      ChauffeurErrorCode.PROVIDER_UNAVAILABLE,
      "Chauffeur verification is temporarily unavailable",
      HttpStatus.BAD_GATEWAY,
      { title: "Verification Unavailable" },
    );
  }
}

export class ChauffeurAccountConflictException extends ChauffeurException {
  constructor() {
    super(
      ChauffeurErrorCode.ACCOUNT_CONFLICT,
      "This account is already linked to another fleet owner",
      HttpStatus.CONFLICT,
      { title: "Chauffeur Account Conflict" },
    );
  }
}

export class ChauffeurNotFoundException extends ChauffeurException {
  constructor() {
    super(ChauffeurErrorCode.NOT_FOUND, "Chauffeur not found", HttpStatus.NOT_FOUND, {
      title: "Chauffeur Not Found",
    });
  }
}

export class ChauffeurOperationFailedException extends ChauffeurException {
  constructor() {
    super(
      ChauffeurErrorCode.OPERATION_FAILED,
      "The chauffeur operation could not be completed",
      HttpStatus.INTERNAL_SERVER_ERROR,
      { title: "Chauffeur Operation Failed" },
    );
  }
}
