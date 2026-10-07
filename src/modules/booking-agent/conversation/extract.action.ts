import { Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { BookingAgentExtractorService } from "./booking-agent-extractor.service";
import { getBookingAgentServiceUnavailableMessage } from "./conversation.const";
import type { BookingAgentState } from "./conversation.interface";
import { normalizeActionError } from "./conversation-log-utils";

@Injectable()
export class ExtractAction {
  constructor(
    private readonly extractorService: BookingAgentExtractorService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ExtractAction.name);
  }

  async run(state: BookingAgentState): Promise<Partial<BookingAgentState>> {
    try {
      const extraction = await this.extractorService.extract(state);
      this.logger.info(
        {
          intent: extraction.intent,
          confidence: extraction.confidence,
          draftPatchFieldCount: Object.keys(extraction.draftPatch ?? {}).length,
          hasDraftPatch: Object.keys(extraction.draftPatch ?? {}).length > 0,
          redactedDraftPatch: true,
        },
        "Extract action completed",
      );
      return { extraction, error: null };
    } catch (error) {
      const normalizedError = normalizeActionError(error);
      this.logger.error(
        {
          errorMessage: normalizedError.errorMessage,
          errorCode: normalizedError.errorCode,
          stackSnippet: normalizedError.stackSnippet,
        },
        "Extract action failed",
      );
      return {
        extraction: {
          intent: "unknown",
          draftPatch: {},
          confidence: 0,
        },
        error: getBookingAgentServiceUnavailableMessage(),
        statusMessage: null,
      };
    }
  }
}
