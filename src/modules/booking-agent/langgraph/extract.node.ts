import { Injectable, Logger } from "@nestjs/common";
import { LANGGRAPH_SERVICE_UNAVAILABLE_MESSAGE } from "./langgraph.const";
import { createDefaultLocationValidationState } from "./langgraph.interface";
import { LangGraphExtractorService } from "./langgraph-extractor.service";
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
        draftPatch: extraction.draftPatch,
        confidence: extraction.confidence,
      });
      return { extraction, error: null };
    } catch (error) {
      this.logger.error("Extract node failed", { error });
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
