import { HttpStatus } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import {
  ChauffeurAccountConflictException,
  ChauffeurBiometricNotVerifiedException,
  ChauffeurErrorCode,
  ChauffeurIdempotencyKeyReusedException,
  ChauffeurInvalidSelfieException,
  ChauffeurInvitationInvalidException,
  ChauffeurInvitationNotAllowedException,
  ChauffeurOperationFailedException,
  ChauffeurRequestInProgressException,
  ChauffeurSessionInvalidException,
  ChauffeurStepIncompleteException,
} from "./chauffeur.error";

describe("Chauffeur exceptions", () => {
  it("maps invitation and session failures to the documented codes and statuses", () => {
    expect(new ChauffeurInvitationNotAllowedException().getStatus()).toBe(HttpStatus.CONFLICT);
    expect(new ChauffeurInvitationNotAllowedException().getErrorCode()).toBe(
      ChauffeurErrorCode.INVITATION_NOT_ALLOWED,
    );
    expect(new ChauffeurInvitationInvalidException().getStatus()).toBe(HttpStatus.GONE);
    expect(new ChauffeurSessionInvalidException().getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    expect(new ChauffeurIdempotencyKeyReusedException().getErrorCode()).toBe(
      ChauffeurErrorCode.IDEMPOTENCY_KEY_REUSED,
    );
  });

  it("exposes retry-after details for in-progress verification", () => {
    const error = new ChauffeurRequestInProgressException();
    expect(error.retryAfterSeconds).toBe(5);
    expect(error.getErrorCode()).toBe(ChauffeurErrorCode.REQUEST_IN_PROGRESS);
    expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
  });

  it("names the required onboarding step", () => {
    const error = new ChauffeurStepIncompleteException("PHONE");
    expect(error.getErrorCode()).toBe(ChauffeurErrorCode.STEP_INCOMPLETE);
    expect(error.message).toContain("phone");
  });

  it("uses conflict for an account that cannot be linked", () => {
    expect(new ChauffeurAccountConflictException().getStatus()).toBe(HttpStatus.CONFLICT);
    expect(new ChauffeurAccountConflictException().getErrorCode()).toBe(
      ChauffeurErrorCode.ACCOUNT_CONFLICT,
    );
  });

  it("maps biometric and unexpected operation failures", () => {
    expect(new ChauffeurBiometricNotVerifiedException().getStatus()).toBe(
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
    expect(new ChauffeurBiometricNotVerifiedException().getErrorCode()).toBe(
      ChauffeurErrorCode.BIOMETRIC_NOT_VERIFIED,
    );
    expect(new ChauffeurOperationFailedException().getStatus()).toBe(
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
    expect(new ChauffeurOperationFailedException().getErrorCode()).toBe(
      ChauffeurErrorCode.OPERATION_FAILED,
    );
    expect(new ChauffeurInvalidSelfieException().getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(new ChauffeurInvalidSelfieException().getErrorCode()).toBe(
      ChauffeurErrorCode.INVALID_SELFIE,
    );
  });
});
