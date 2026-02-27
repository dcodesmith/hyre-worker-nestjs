import type Redis from "ioredis";
import type OpenAI from "openai";

export const WHATSAPP_OPENAI_CLIENT = Symbol("WHATSAPP_OPENAI_CLIENT");
export const WHATSAPP_REDIS_CLIENT = Symbol("WHATSAPP_REDIS_CLIENT");

export type WhatsAppOpenAiClient = Pick<OpenAI, "chat">;
export type WhatsAppRedisClient = Pick<Redis, "get" | "set" | "del" | "quit">;
