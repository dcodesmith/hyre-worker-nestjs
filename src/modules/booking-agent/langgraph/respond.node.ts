import { Injectable, Logger } from "@nestjs/common";
import type { LangGraphNodeResult, LangGraphNodeState } from "./langgraph-node-state.interface";
import { buildOutboxItems } from "./langgraph-outbox.builder";
import { LangGraphResponderService } from "./langgraph-responder.service";

@Injectable()
export class RespondNode {
  private readonly logger = new Logger(RespondNode.name);

  constructor(private readonly responderService: LangGraphResponderService) {}

  async run(state: LangGraphNodeState): Promise<LangGraphNodeResult> {
    try {
      if (state.outboxItems.length > 0 && state.response) {
        return {};
      }

      this.logger.log(
        {
          stage: state.stage,
          availableOptionsCount: state.availableOptions.length,
          lastShownOptionsCount: state.lastShownOptions.length,
          hasSelectedOption: !!state.selectedOption,
        },
        "Respond node executing",
      );
      this.logger.debug("Respond node draft details", { draft: state.draft });

      const response = await this.responderService.generateResponse(state);
      const outboxItems = buildOutboxItems(state, response);
      return { response, outboxItems };
    } catch (error) {
      this.logger.error("Respond node failed", { error });
      return {
        response: {
          text: "I'm having trouble right now. Please try again or type AGENT to speak with someone.",
        },
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
