import { Injectable } from "@nestjs/common";
import { BOOKING_AGENT_OUTBOUND_MODE } from "./conversation.const";
import type { BookingAgentState } from "./conversation.interface";

@Injectable()
export class HandoffAction {
  run(state: BookingAgentState): Partial<BookingAgentState> {
    const HANDOFF_MESSAGE =
      "A Tripdly agent will join this chat shortly. Please share your booking reference if available.";
    return {
      response: {
        text: HANDOFF_MESSAGE,
      },
      outboxItems: [
        {
          conversationId: state.conversationId,
          dedupeKey: `booking-agent:handoff:${state.inboundMessageId}`,
          mode: BOOKING_AGENT_OUTBOUND_MODE.FREE_FORM,
          textBody: HANDOFF_MESSAGE,
        },
      ],
      stage: "cancelled",
    };
  }
}
