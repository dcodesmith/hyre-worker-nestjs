import { Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { getMissingRequiredFields } from "../booking-agent.helper";
import { BOOKING_AGENT_ACTIONS, BOOKING_AGENT_SERVICE_UNAVAILABLE_MESSAGE } from "./conversation.const";
import {
  type BookingAgentRouteDecision,
  type BookingAgentState,
  createDefaultLocationValidationState,
  type LocationValidationState,
} from "./conversation.interface";
import { resolveRouteDecision } from "./booking-agent-router.policy";

@Injectable()
export class RouteAction {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(RouteAction.name);
  }

  run(state: BookingAgentState): BookingAgentRouteDecision {
    const { extraction, draft, stage, availableOptions, selectedOption } = state;

    if (state.error === BOOKING_AGENT_SERVICE_UNAVAILABLE_MESSAGE) {
      return {
        nextAction: BOOKING_AGENT_ACTIONS.RESPOND,
        stage: "greeting",
      };
    }

    const missingFields = getMissingRequiredFields(draft);
    this.logger.info(
      {
        intent: extraction?.intent,
        stage,
        missingFields,
        hasSelectedOption: !!selectedOption,
        availableOptionsCount: availableOptions.length,
        draft: {
          bookingType: draft.bookingType,
          pickupDate: draft.pickupDate,
          pickupTime: draft.pickupTime,
          dropoffDate: draft.dropoffDate,
          hasPickupLocation: !!draft.pickupLocation,
          hasDropoffLocation: !!draft.dropoffLocation,
        },
      },
      "Route action decision",
    );

    const decision = resolveRouteDecision(state);
    const isControlIntent =
      extraction?.intent === "new_booking" ||
      extraction?.intent === "reset" ||
      extraction?.intent === "greeting" ||
      extraction?.intent === "cancel" ||
      extraction?.intent === "request_agent";
    const shouldRunEarlyPickupValidation =
      !isControlIntent &&
      (decision.nextAction ?? BOOKING_AGENT_ACTIONS.RESPOND) === BOOKING_AGENT_ACTIONS.RESPOND &&
      (decision.stage ?? stage) === "collecting" &&
      !!draft.pickupLocation &&
      this.shouldValidateLocationField(
        draft.pickupLocation,
        this.getLocationValidationState(state).pickup,
      );
    if (shouldRunEarlyPickupValidation) {
      return {
        ...decision,
        nextAction: BOOKING_AGENT_ACTIONS.SEARCH,
        stage: "collecting",
      };
    }

    return decision;
  }

  private getLocationValidationState(
    state: Pick<BookingAgentState, "locationValidation">,
  ): BookingAgentState["locationValidation"] {
    return state.locationValidation ?? createDefaultLocationValidationState();
  }

  private shouldValidateLocationField(
    locationValue: string | undefined,
    validation: LocationValidationState,
  ): boolean {
    const normalizedInput = locationValue?.trim();
    if (!normalizedInput) {
      return false;
    }

    if (validation.lastValidatedInput !== normalizedInput) {
      return true;
    }

    return validation.status === "unvalidated";
  }
}
