import { HttpStatus } from "@nestjs/common";
import { AppException } from "../../common/errors/app.exception";

export const ReviewErrorCode = {
  BOOKING_NOT_FOUND: "BOOKING_NOT_FOUND",
  BOOKING_NOT_COMPLETED: "BOOKING_NOT_COMPLETED",
  REVIEW_OWNERSHIP_REQUIRED: "REVIEW_OWNERSHIP_REQUIRED",
  BOOKING_CHAUFFEUR_REQUIRED: "BOOKING_CHAUFFEUR_REQUIRED",
  REVIEW_CREATION_WINDOW_EXPIRED: "REVIEW_CREATION_WINDOW_EXPIRED",
  REVIEW_ALREADY_EXISTS: "REVIEW_ALREADY_EXISTS",
  REVIEW_NOT_FOUND: "REVIEW_NOT_FOUND",
  REVIEW_UPDATE_WINDOW_EXPIRED: "REVIEW_UPDATE_WINDOW_EXPIRED",
} as const;

export class ReviewException extends AppException {
  // Intentionally empty: inherits AppException constructor.
}

export class ReviewBookingNotFoundException extends ReviewException {
  constructor() {
    super(ReviewErrorCode.BOOKING_NOT_FOUND, "Booking not found", HttpStatus.NOT_FOUND, {
      title: "Booking Not Found",
    });
  }
}

export class ReviewBookingNotCompletedException extends ReviewException {
  constructor() {
    super(
      ReviewErrorCode.BOOKING_NOT_COMPLETED,
      "Review can only be created for completed bookings",
      HttpStatus.BAD_REQUEST,
      {
        title: "Invalid Booking Status",
      },
    );
  }
}

export class ReviewOwnershipRequiredException extends ReviewException {
  constructor(detail = "You can only review your own bookings") {
    super(ReviewErrorCode.REVIEW_OWNERSHIP_REQUIRED, detail, HttpStatus.FORBIDDEN, {
      title: "Review Ownership Required",
    });
  }
}

export class ReviewBookingChauffeurRequiredException extends ReviewException {
  constructor() {
    super(
      ReviewErrorCode.BOOKING_CHAUFFEUR_REQUIRED,
      "Booking must have a chauffeur assigned",
      HttpStatus.BAD_REQUEST,
      {
        title: "Booking Chauffeur Required",
      },
    );
  }
}

export class ReviewCreationWindowExpiredException extends ReviewException {
  constructor() {
    super(
      ReviewErrorCode.REVIEW_CREATION_WINDOW_EXPIRED,
      "Review can only be created within 30 days of booking completion",
      HttpStatus.BAD_REQUEST,
      {
        title: "Review Creation Window Expired",
      },
    );
  }
}

export class ReviewAlreadyExistsException extends ReviewException {
  constructor() {
    super(
      ReviewErrorCode.REVIEW_ALREADY_EXISTS,
      "Review already exists for this booking",
      HttpStatus.CONFLICT,
      {
        title: "Review Already Exists",
      },
    );
  }
}

export class ReviewNotFoundException extends ReviewException {
  constructor() {
    super(ReviewErrorCode.REVIEW_NOT_FOUND, "Review not found", HttpStatus.NOT_FOUND, {
      title: "Review Not Found",
    });
  }
}

export class ReviewUpdateWindowExpiredException extends ReviewException {
  constructor() {
    super(
      ReviewErrorCode.REVIEW_UPDATE_WINDOW_EXPIRED,
      "Review can only be edited within 7 days of creation",
      HttpStatus.BAD_REQUEST,
      {
        title: "Review Update Window Expired",
      },
    );
  }
}
