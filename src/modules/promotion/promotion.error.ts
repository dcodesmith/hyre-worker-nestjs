import { HttpStatus } from "@nestjs/common";
import { AppException } from "../../common/errors/app.exception";

export const PromotionErrorCode = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  PROMOTION_NOT_FOUND: "PROMOTION_NOT_FOUND",
  PROMOTION_CAR_NOT_FOUND: "PROMOTION_CAR_NOT_FOUND",
  PROMOTION_OVERLAP: "PROMOTION_OVERLAP",
  PROMOTION_CREATE_FAILED: "PROMOTION_CREATE_FAILED",
  PROMOTION_FETCH_FAILED: "PROMOTION_FETCH_FAILED",
  PROMOTION_UPDATE_FAILED: "PROMOTION_UPDATE_FAILED",
} as const;

export class PromotionException extends AppException {}

export class PromotionValidationException extends PromotionException {
  constructor(detail: string) {
    super(PromotionErrorCode.VALIDATION_ERROR, detail, HttpStatus.BAD_REQUEST, {
      title: "Validation Failed",
    });
  }
}

export class PromotionNotFoundException extends PromotionException {
  constructor() {
    super(
      PromotionErrorCode.PROMOTION_NOT_FOUND,
      "Promotion not found or you do not have access to it",
      HttpStatus.NOT_FOUND,
      { title: "Promotion Not Found" },
    );
  }
}

export class PromotionCarNotFoundException extends PromotionException {
  constructor() {
    super(
      PromotionErrorCode.PROMOTION_CAR_NOT_FOUND,
      "Car not found in your fleet",
      HttpStatus.NOT_FOUND,
      { title: "Car Not Found" },
    );
  }
}

export class PromotionOverlapException extends PromotionException {
  constructor() {
    super(
      PromotionErrorCode.PROMOTION_OVERLAP,
      "An overlapping promotion already exists for this scope. Deactivate or reschedule it first.",
      HttpStatus.CONFLICT,
      { title: "Overlapping Promotion" },
    );
  }
}

export class PromotionCreateFailedException extends PromotionException {
  constructor() {
    super(
      PromotionErrorCode.PROMOTION_CREATE_FAILED,
      "An unexpected error occurred while creating the promotion",
      HttpStatus.INTERNAL_SERVER_ERROR,
      { title: "Promotion Create Failed" },
    );
  }
}

export class PromotionFetchFailedException extends PromotionException {
  constructor() {
    super(
      PromotionErrorCode.PROMOTION_FETCH_FAILED,
      "An unexpected error occurred while fetching promotions",
      HttpStatus.INTERNAL_SERVER_ERROR,
      { title: "Promotion Fetch Failed" },
    );
  }
}

export class PromotionUpdateFailedException extends PromotionException {
  constructor() {
    super(
      PromotionErrorCode.PROMOTION_UPDATE_FAILED,
      "An unexpected error occurred while updating the promotion",
      HttpStatus.INTERNAL_SERVER_ERROR,
      { title: "Promotion Update Failed" },
    );
  }
}
