import { Injectable } from "@nestjs/common";
import { LANGGRAPH_OUTBOUND_MODE } from "./langgraph.const";
import type { LangGraphNodeResult, LangGraphNodeState } from "./langgraph-node-state.interface";

@Injectable()
export class HandoffNode {
  run(state: LangGraphNodeState): LangGraphNodeResult {
    return {
      response: {
        text: "A Tripdly agent will join this chat shortly. Please share your booking reference if available.",
      },
      outboxItems: [
        {
          conversationId: state.conversationId,
          dedupeKey: `langgraph:handoff:${state.inboundMessageId}`,
          mode: LANGGRAPH_OUTBOUND_MODE.FREE_FORM,
          textBody:
            "A Tripdly agent will join this chat shortly. Please share your booking reference if available.",
        },
      ],
      stage: "cancelled",
    };
  }
}
