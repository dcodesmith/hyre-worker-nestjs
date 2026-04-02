import { Injectable } from "@nestjs/common";
import { LANGGRAPH_OUTBOUND_MODE } from "./langgraph.const";
import type { LangGraphNodeResult, LangGraphNodeState } from "./langgraph-node-state.interface";

@Injectable()
export class HandoffNode {
  run(state: LangGraphNodeState): LangGraphNodeResult {
    const HANDOFF_MESSAGE =
      "A Tripdly agent will join this chat shortly. Please share your booking reference if available.";
    return {
      response: {
        text: HANDOFF_MESSAGE,
      },
      outboxItems: [
        {
          conversationId: state.conversationId,
          dedupeKey: `langgraph:handoff:${state.inboundMessageId}`,
          mode: LANGGRAPH_OUTBOUND_MODE.FREE_FORM,
          textBody: HANDOFF_MESSAGE,
        },
      ],
      stage: "cancelled",
    };
  }
}
