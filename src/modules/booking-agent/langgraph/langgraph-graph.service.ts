import { END, START, StateGraph } from "@langchain/langgraph";
import { Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { CreateBookingNode } from "./create-booking.node";
import { ExtractNode } from "./extract.node";
import { HandoffNode } from "./handoff.node";
import { LANGGRAPH_NODE_NAMES } from "./langgraph.const";
import { LangGraphExecutionFailedException } from "./langgraph.error";
import type {
  BookingAgentState,
  LangGraphInvokeInput,
  LangGraphInvokeResult,
} from "./langgraph.interface";
import { AnnotationState, BookingAgentAnnotation } from "./langgraph-state.annotation";
import { LangGraphStateService } from "./langgraph-state.service";
import { MergeNode } from "./merge.node";
import { RespondNode } from "./respond.node";
import { RouteNode } from "./route.node";
import { SearchNode } from "./search.node";

@Injectable()
export class LangGraphGraphService {
  private graph: ReturnType<typeof this.buildGraph> | null = null;

  constructor(
    private readonly stateService: LangGraphStateService,
    private readonly extractNode: ExtractNode,
    private readonly mergeNode: MergeNode,
    private readonly routeNode: RouteNode,
    private readonly searchNode: SearchNode,
    private readonly createBookingNode: CreateBookingNode,
    private readonly respondNode: RespondNode,
    private readonly handoffNode: HandoffNode,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(LangGraphGraphService.name);
  }

  async invoke(input: LangGraphInvokeInput): Promise<LangGraphInvokeResult> {
    const { conversationId, messageId, message, interactive, customerId } = input;

    try {
      const existingState = await this.stateService.loadState(conversationId);

      let initialState: BookingAgentState;
      if (existingState) {
        initialState = this.stateService.mergeWithExisting(
          existingState,
          conversationId,
          messageId,
          message,
          customerId ?? null,
        );
      } else {
        initialState = this.stateService.createInitialState(
          conversationId,
          messageId,
          message,
          customerId ?? null,
        );
      }

      if (interactive) {
        initialState.inboundInteractive = interactive;
      }

      this.stateService.addMessage(initialState, "user", message);

      const graph = this.getOrBuildGraph();
      const finalStateResult = await graph.invoke(initialState, {
        configurable: { thread_id: conversationId },
      });

      if (finalStateResult.response) {
        this.stateService.addMessage(finalStateResult, "assistant", finalStateResult.response.text);
      }

      await this.stateService.saveState(conversationId, finalStateResult);

      const { response, outboxItems, stage, draft, error } = finalStateResult;

      return { response, outboxItems, stage, draft, error };
    } catch (error) {
      this.logger.error(
        {
          conversationId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Graph execution failed",
      );
      throw new LangGraphExecutionFailedException(conversationId, "invoke");
    }
  }

  private getOrBuildGraph() {
    if (!this.graph) {
      this.graph = this.buildGraph();
    }
    return this.graph;
  }

  private buildGraph() {
    const workflow = new StateGraph(BookingAgentAnnotation)
      .addNode(LANGGRAPH_NODE_NAMES.EXTRACT, this.extractNode.run.bind(this.extractNode))
      .addNode(LANGGRAPH_NODE_NAMES.MERGE, this.mergeNode.run.bind(this.mergeNode))
      .addNode(LANGGRAPH_NODE_NAMES.ROUTE, this.routeNode.run.bind(this.routeNode))
      .addNode(LANGGRAPH_NODE_NAMES.SEARCH, this.searchNode.run.bind(this.searchNode))
      .addNode(
        LANGGRAPH_NODE_NAMES.CREATE_BOOKING,
        this.createBookingNode.run.bind(this.createBookingNode),
      )
      .addNode(LANGGRAPH_NODE_NAMES.RESPOND, this.respondNode.run.bind(this.respondNode))
      .addNode(LANGGRAPH_NODE_NAMES.HANDOFF, this.handoffNode.run.bind(this.handoffNode))
      .addEdge(START, LANGGRAPH_NODE_NAMES.EXTRACT)
      .addEdge(LANGGRAPH_NODE_NAMES.EXTRACT, LANGGRAPH_NODE_NAMES.MERGE)
      .addEdge(LANGGRAPH_NODE_NAMES.MERGE, LANGGRAPH_NODE_NAMES.ROUTE)
      .addConditionalEdges(LANGGRAPH_NODE_NAMES.ROUTE, this.routeDecision.bind(this))
      .addEdge(LANGGRAPH_NODE_NAMES.SEARCH, LANGGRAPH_NODE_NAMES.RESPOND)
      .addEdge(LANGGRAPH_NODE_NAMES.CREATE_BOOKING, LANGGRAPH_NODE_NAMES.RESPOND)
      .addEdge(LANGGRAPH_NODE_NAMES.RESPOND, END)
      .addEdge(LANGGRAPH_NODE_NAMES.HANDOFF, END);

    return workflow.compile();
  }

  private routeDecision(state: AnnotationState): string {
    return state.nextNode ?? LANGGRAPH_NODE_NAMES.RESPOND;
  }
}
