export const BOOKING_AGENT_ANTHROPIC_CLIENT = Symbol("BOOKING_AGENT_ANTHROPIC_CLIENT");
export const BOOKING_AGENT_OPENAI_CLIENT = Symbol("BOOKING_AGENT_OPENAI_CLIENT");
export const BOOKING_AGENT_REDIS_CLIENT = Symbol("BOOKING_AGENT_REDIS_CLIENT");

export type BookingAgentAnthropicClient = import("@langchain/anthropic").ChatAnthropic;
export type BookingAgentOpenAIClient = import("@langchain/openai").ChatOpenAI;
export type BookingAgentRedisClient = import("ioredis").default;
