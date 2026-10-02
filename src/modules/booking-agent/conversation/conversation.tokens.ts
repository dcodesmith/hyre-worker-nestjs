export const BOOKING_AGENT_ANTHROPIC_CLIENT = Symbol("BOOKING_AGENT_ANTHROPIC_CLIENT");
export const BOOKING_AGENT_REDIS_CLIENT = Symbol("BOOKING_AGENT_REDIS_CLIENT");

export type BookingAgentAnthropicClient = import("@anthropic-ai/sdk").default;
export type BookingAgentRedisClient = import("ioredis").default;
