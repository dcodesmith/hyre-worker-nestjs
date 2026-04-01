import { Injectable, Logger } from "@nestjs/common";
import { getMissingRequiredFields } from "../booking-agent.helper";
import { LANGGRAPH_NODE_NAMES, LANGGRAPH_SERVICE_UNAVAILABLE_MESSAGE } from "./langgraph.const";
import {
  type BookingAgentState,
  createDefaultLocationValidationState,
  type LocationValidationState,
} from "./langgraph.interface";
import type { LangGraphNodeResult, LangGraphNodeState } from "./langgraph-node-state.interface";
import { resolveRouteDecision } from "./langgraph-router.policy";

@Injectable()
export class RouteNode {
  private readonly logger = new Logger(RouteNode.name);

  run(state: LangGraphNodeState): LangGraphNodeResult {
    const { extraction, draft, stage, availableOptions, selectedOption } = state;

    if (state.error === LANGGRAPH_SERVICE_UNAVAILABLE_MESSAGE) {
      return {
        nextNode: LANGGRAPH_NODE_NAMES.RESPOND,
        stage: "greeting",
      };
    }

    const missingFields = getMissingRequiredFields(draft);
    this.logger.log("Route node decision", {
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
        pickupLocation: draft.pickupLocation,
        dropoffLocation: draft.dropoffLocation,
      },
    });

    const decision = resolveRouteDecision(state);
    const isControlIntent =
      extraction?.intent === "new_booking" ||
      extraction?.intent === "reset" ||
      extraction?.intent === "greeting" ||
      extraction?.intent === "cancel" ||
      extraction?.intent === "request_agent";
    const shouldRunEarlyPickupValidation =
      !isControlIntent &&
      (decision.nextNode ?? LANGGRAPH_NODE_NAMES.RESPOND) === LANGGRAPH_NODE_NAMES.RESPOND &&
      (decision.stage ?? stage) === "collecting" &&
      !!draft.pickupLocation &&
      this.shouldValidateLocationField(
        draft.pickupLocation,
        this.getLocationValidationState(state).pickup,
      );
    if (shouldRunEarlyPickupValidation) {
      return {
        ...decision,
        nextNode: LANGGRAPH_NODE_NAMES.SEARCH,
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
