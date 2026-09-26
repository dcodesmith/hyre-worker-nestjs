import { HttpStatus } from "@nestjs/common";
import { AppException } from "../../common/errors/app.exception";

export class InterventionNotFoundException extends AppException {
  constructor() {
    super(
      "VERIFICATION_INTERVENTION_NOT_FOUND",
      "Verification intervention not found",
      HttpStatus.NOT_FOUND,
      { title: "Intervention Not Found" },
    );
  }
}

export class InterventionAlreadyResolvedException extends AppException {
  constructor() {
    super(
      "VERIFICATION_INTERVENTION_RESOLVED",
      "This verification intervention has already been resolved",
      HttpStatus.CONFLICT,
      { title: "Intervention Already Resolved" },
    );
  }
}

export class InterventionEvidenceRequiredException extends AppException {
  constructor(detail: string) {
    super("INTERVENTION_EVIDENCE_REQUIRED", detail, HttpStatus.BAD_REQUEST, {
      title: "Independent Evidence Required",
    });
  }
}
