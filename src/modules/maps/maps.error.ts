import { HttpStatus } from "@nestjs/common";
import { AppException } from "../../common/errors/app.exception";

export const MapsErrorCode = {
  PLACES_RATE_LIMIT_EXCEEDED: "PLACES_RATE_LIMIT_EXCEEDED",
} as const;

export class MapsException extends AppException {}

export class PlacesRateLimitExceededException extends MapsException {
  constructor() {
    super(
      MapsErrorCode.PLACES_RATE_LIMIT_EXCEEDED,
      "Too many places requests. Please try again shortly.",
      HttpStatus.TOO_MANY_REQUESTS,
      {
        title: "Too Many Requests",
      },
    );
  }
}
