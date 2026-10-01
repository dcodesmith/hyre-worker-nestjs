import { Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { normalizeActionError } from "./conversation-log-utils";
import { buildOutboxItems } from "./booking-agent-outbox.builder";
import { BookingAgentResponderService } from "./booking-agent-responder.service";
import type { BookingAgentState } from "./conversation.interface";

@Injectable()
export class RespondAction {
  constructor(
    private readonly responderService: BookingAgentResponderService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RespondAction.name);
  }

  async run(state: BookingAgentState): Promise<Partial<BookingAgentState>> {
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
        "Respond action executing",
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
        "Respond action draft details",
      );

      const response = await this.responderService.generateResponse(state);
      const outboxItems = buildOutboxItems(state, response);
      return { response, outboxItems };
    } catch (error) {
      const normalizedError = normalizeActionError(error);
      this.logger.error(
        {
          errorMessage: normalizedError.errorMessage,
          errorCode: normalizedError.errorCode,
          stackSnippet: normalizedError.stackSnippet,
        },
        "Respond action failed",
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
