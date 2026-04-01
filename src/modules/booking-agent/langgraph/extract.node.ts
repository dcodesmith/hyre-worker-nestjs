import { Injectable, Logger } from "@nestjs/common";
import { LANGGRAPH_SERVICE_UNAVAILABLE_MESSAGE } from "./langgraph.const";
import { createDefaultLocationValidationState } from "./langgraph.interface";
import { LangGraphExtractorService } from "./langgraph-extractor.service";
import { normalizeNodeError } from "./langgraph-log-utils";
import type { LangGraphNodeResult, LangGraphNodeState } from "./langgraph-node-state.interface";

@Injectable()
export class ExtractNode {
  private readonly logger = new Logger(ExtractNode.name);

  constructor(private readonly extractorService: LangGraphExtractorService) {}

  async run(state: LangGraphNodeState): Promise<LangGraphNodeResult> {
    try {
      const extraction = await this.extractorService.extract(state);
      this.logger.log("Extract node completed", {
        intent: extraction.intent,
        confidence: extraction.confidence,
        draftPatchFieldCount: Object.keys(extraction.draftPatch ?? {}).length,
        hasDraftPatch: Object.keys(extraction.draftPatch ?? {}).length > 0,
        redactedDraftPatch: true,
      });
      return { extraction, error: null };
    } catch (error) {
      const normalizedError = normalizeNodeError(error);
      this.logger.error("Extract node failed", {
        errorMessage: normalizedError.errorMessage,
        errorCode: normalizedError.errorCode,
        stackSnippet: normalizedError.stackSnippet,
      });
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
