import { Injectable, Logger } from "@nestjs/common";
import { normalizeNodeError } from "./langgraph-log-utils";
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
      this.logger.debug("Respond node draft details", {
        draftFieldCount: Object.keys(state.draft).length,
        hasPickupLocation: !!state.draft.pickupLocation,
        hasDropoffLocation: !!state.draft.dropoffLocation,
        hasPickupDate: !!state.draft.pickupDate,
        hasDropoffDate: !!state.draft.dropoffDate,
        hasVehiclePreferences: !!(
          state.draft.vehicleType ||
          state.draft.serviceTier ||
          state.draft.make ||
          state.draft.model ||
          state.draft.color
        ),
      });

      const response = await this.responderService.generateResponse(state);
      const outboxItems = buildOutboxItems(state, response);
      return { response, outboxItems };
    } catch (error) {
      const normalizedError = normalizeNodeError(error);
      this.logger.error("Respond node failed", {
        errorMessage: normalizedError.errorMessage,
        errorCode: normalizedError.errorCode,
        stackSnippet: normalizedError.stackSnippet,
      });
      return {
        response: {
          text: "I'm having trouble right now. Please try again or type AGENT to speak with someone.",
        },
        error: normalizedError.errorMessage,
      };
    }
  }
}
