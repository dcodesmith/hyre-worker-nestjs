import { Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { normalizeNodeError } from "./langgraph-log-utils";
import type { LangGraphNodeResult, LangGraphNodeState } from "./langgraph-node-state.interface";
import { buildOutboxItems } from "./langgraph-outbox.builder";
import { LangGraphResponderService } from "./langgraph-responder.service";

@Injectable()
export class RespondNode {
  constructor(
    private readonly responderService: LangGraphResponderService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RespondNode.name);
  }

  async run(state: LangGraphNodeState): Promise<LangGraphNodeResult> {
    try {
      if (state.outboxItems.length > 0 && state.response) {
        return {};
      }

      this.logger.info(
        {
          stage: state.stage,
          availableOptionsCount: state.availableOptions.length,
          lastShownOptionsCount: state.lastShownOptions.length,
          hasSelectedOption: !!state.selectedOption,
        },
        "Respond node executing",
      );
      this.logger.debug(
        {
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
        },
        "Respond node draft details",
      );

      const response = await this.responderService.generateResponse(state);
      const outboxItems = buildOutboxItems(state, response);
      return { response, outboxItems };
    } catch (error) {
      const normalizedError = normalizeNodeError(error);
      this.logger.error(
        {
          errorMessage: normalizedError.errorMessage,
          errorCode: normalizedError.errorCode,
          stackSnippet: normalizedError.stackSnippet,
        },
        "Respond node failed",
      );
      return {
        response: {
          text: "I'm having trouble right now. Please try again or type AGENT to speak with someone.",
        },
        error: normalizedError.errorMessage,
      };
    }
  }
}
