import { Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { LANGGRAPH_SERVICE_UNAVAILABLE_MESSAGE } from "./langgraph.const";
import { createDefaultLocationValidationState } from "./langgraph.interface";
import { LangGraphExtractorService } from "./langgraph-extractor.service";
import { normalizeNodeError } from "./langgraph-log-utils";
import type { LangGraphNodeResult, LangGraphNodeState } from "./langgraph-node-state.interface";

@Injectable()
export class ExtractNode {
  constructor(
    private readonly extractorService: LangGraphExtractorService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ExtractNode.name);
  }

  async run(state: LangGraphNodeState): Promise<LangGraphNodeResult> {
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
        "Extract node completed",
      );
      return { extraction, error: null };
    } catch (error) {
      const normalizedError = normalizeNodeError(error);
      this.logger.error(
        {
          errorMessage: normalizedError.errorMessage,
          errorCode: normalizedError.errorCode,
          stackSnippet: normalizedError.stackSnippet,
        },
        "Extract node failed",
      );
      return {
        extraction: {
          intent: "unknown",
          draftPatch: {},
          confidence: 0,
        },
        error: LANGGRAPH_SERVICE_UNAVAILABLE_MESSAGE,
        statusMessage: null,
        draft: { __clear: true },
        preferences: { __clear: true },
        availableOptions: [],
        lastShownOptions: [],
        selectedOption: null,
        locationValidation: createDefaultLocationValidationState(),
        stage: "greeting",
      };
    }
  }
}
