import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PinoLogger } from "nestjs-pino";
import type { EnvConfig } from "../../../config/env.config";
import { buildOutboxItems } from "./booking-agent-outbox.builder";
import { BookingAgentResponderService } from "./booking-agent-responder.service";
import { payNowCheckoutHost } from "./conversation.const";
import type { BookingAgentState } from "./conversation.interface";
import { normalizeActionError } from "./conversation-log-utils";

@Injectable()
export class RespondAction {
  constructor(
    private readonly responderService: BookingAgentResponderService,
    private readonly configService: ConfigService<EnvConfig, true>,
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
      const outboxItems = buildOutboxItems(state, response, {
        contentSid: this.configService.get("TWILIO_AGENT_PAY_NOW_CONTENT_SID", { infer: true }),
        checkoutHost: payNowCheckoutHost(this.configService.get("APP_ENV", { infer: true })),
      });
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
