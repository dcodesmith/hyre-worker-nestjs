export const LANGGRAPH_ANTHROPIC_CLIENT = Symbol("LANGGRAPH_ANTHROPIC_CLIENT");
export const LANGGRAPH_OPENAI_CLIENT = Symbol("LANGGRAPH_OPENAI_CLIENT");
export const LANGGRAPH_REDIS_CLIENT = Symbol("LANGGRAPH_REDIS_CLIENT");

export type LangGraphAnthropicClient = import("@langchain/anthropic").ChatAnthropic;
export type LangGraphOpenAIClient = import("@langchain/openai").ChatOpenAI;
export type LangGraphRedisClient = import("ioredis").default;
