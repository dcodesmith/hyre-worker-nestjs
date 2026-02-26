import { HttpStatus } from "@nestjs/common";
import { AppException } from "../../common/errors/app.exception";

export const AiSearchErrorCode = {
  AI_SEARCH_FAILED: "AI_SEARCH_FAILED",
  AI_SEARCH_TIMEOUT: "AI_SEARCH_TIMEOUT",
  AI_SEARCH_PROVIDER_RESPONSE_INVALID: "AI_SEARCH_PROVIDER_RESPONSE_INVALID",
} as const;

export class AiSearchException extends AppException {}

export class AiSearchFailedException extends AiSearchException {
  constructor() {
    super(
      AiSearchErrorCode.AI_SEARCH_FAILED,
      "Failed to process search. Please try again.",
      HttpStatus.INTERNAL_SERVER_ERROR,
      {
        title: "AI Search Failed",
      },
    );
  }
}

export class AiSearchTimeoutException extends AiSearchException {
  constructor() {
    super(
      AiSearchErrorCode.AI_SEARCH_TIMEOUT,
      "AI search request timed out. Please try again.",
      HttpStatus.GATEWAY_TIMEOUT,
      {
        title: "AI Search Timeout",
      },
    );
  }
}

export class AiSearchProviderResponseInvalidException extends AiSearchException {
  constructor() {
    super(
      AiSearchErrorCode.AI_SEARCH_PROVIDER_RESPONSE_INVALID,
      "AI provider returned an invalid response.",
      HttpStatus.BAD_GATEWAY,
      {
        title: "AI Provider Response Invalid",
      },
    );
  }
}
