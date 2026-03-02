import { HttpStatus, Logger } from "@nestjs/common";
import { AppException } from "../../../common/errors/app.exception";

export const LangGraphErrorCode = {
  LANGGRAPH_EXTRACTION_FAILED: "LANGGRAPH_EXTRACTION_FAILED",
  LANGGRAPH_RESPONSE_FAILED: "LANGGRAPH_RESPONSE_FAILED",
  LANGGRAPH_GRAPH_EXECUTION_FAILED: "LANGGRAPH_GRAPH_EXECUTION_FAILED",
  LANGGRAPH_STATE_PERSIST_FAILED: "LANGGRAPH_STATE_PERSIST_FAILED",
  LANGGRAPH_STATE_LOAD_FAILED: "LANGGRAPH_STATE_LOAD_FAILED",
  LANGGRAPH_INVALID_NODE_TRANSITION: "LANGGRAPH_INVALID_NODE_TRANSITION",
  LANGGRAPH_TIMEOUT: "LANGGRAPH_TIMEOUT",
} as const;

const logger = new Logger("LangGraphError");

export class LangGraphException extends AppException {}

export class LangGraphExtractionFailedException extends LangGraphException {
  constructor(conversationId: string, error: string) {
    logger.error("LangGraph extraction failed", { conversationId, error });
    super(
      LangGraphErrorCode.LANGGRAPH_EXTRACTION_FAILED,
      `Failed to extract intent from message for conversation ${conversationId}`,
      HttpStatus.INTERNAL_SERVER_ERROR,
      {
        title: "LangGraph Extraction Failed",
        details: { conversationId },
      },
    );
  }
}

export class LangGraphResponseFailedException extends LangGraphException {
  constructor(conversationId: string, error: string) {
    logger.error("LangGraph response generation failed", { conversationId, error });
    super(
      LangGraphErrorCode.LANGGRAPH_RESPONSE_FAILED,
      `Failed to generate response for conversation ${conversationId}`,
      HttpStatus.INTERNAL_SERVER_ERROR,
      {
        title: "LangGraph Response Failed",
        details: { conversationId },
      },
    );
  }
}

export class LangGraphExecutionFailedException extends LangGraphException {
  constructor(conversationId: string, node: string, error: string) {
    logger.error("LangGraph execution failed", { conversationId, node, error });
    super(
      LangGraphErrorCode.LANGGRAPH_GRAPH_EXECUTION_FAILED,
      `Graph execution failed at node "${node}" for conversation ${conversationId}`,
      HttpStatus.INTERNAL_SERVER_ERROR,
      {
        title: "LangGraph Execution Failed",
        details: { conversationId, node },
      },
    );
  }
}

export class LangGraphStatePersistFailedException extends LangGraphException {
  constructor(conversationId: string, attempts: number) {
    super(
      LangGraphErrorCode.LANGGRAPH_STATE_PERSIST_FAILED,
      `Failed to persist state for conversation ${conversationId} after ${attempts} attempts`,
      HttpStatus.SERVICE_UNAVAILABLE,
      {
        title: "LangGraph State Persist Failed",
        details: { conversationId, attempts },
      },
    );
  }
}

export class LangGraphStateLoadFailedException extends LangGraphException {
  constructor(conversationId: string, error: string) {
    logger.error("LangGraph state load failed", { conversationId, error });
    super(
      LangGraphErrorCode.LANGGRAPH_STATE_LOAD_FAILED,
      `Failed to load state for conversation ${conversationId}`,
      HttpStatus.INTERNAL_SERVER_ERROR,
      {
        title: "LangGraph State Load Failed",
        details: { conversationId },
      },
    );
  }
}

export class LangGraphInvalidNodeTransitionException extends LangGraphException {
  constructor(fromNode: string, toNode: string) {
    super(
      LangGraphErrorCode.LANGGRAPH_INVALID_NODE_TRANSITION,
      `Invalid node transition from "${fromNode}" to "${toNode}"`,
      HttpStatus.INTERNAL_SERVER_ERROR,
      {
        title: "LangGraph Invalid Node Transition",
        details: { fromNode, toNode },
      },
    );
  }
}

export class LangGraphTimeoutException extends LangGraphException {
  constructor(operation: string, timeoutMs: number) {
    super(
      LangGraphErrorCode.LANGGRAPH_TIMEOUT,
      `LangGraph operation "${operation}" timed out after ${timeoutMs}ms`,
      HttpStatus.GATEWAY_TIMEOUT,
      {
        title: "LangGraph Timeout",
        details: { operation, timeoutMs },
      },
    );
  }
}
