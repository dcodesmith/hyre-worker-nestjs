import type { JobsOptions } from "bullmq";

export const WHATSAPP_AGENT_ACK_XML = "<Response></Response>";
export const WHATSAPP_SERVICE_WINDOW_HOURS = 24;
export const WHATSAPP_PROCESSING_LOCK_TTL_MS = 60_000;

export const WHATSAPP_DEFAULT_JOB_ATTEMPTS = 3;
export const WHATSAPP_DEFAULT_BACKOFF_MS = 2_000;
export const WHATSAPP_DEFAULT_REMOVE_ON_COMPLETE = 100;
export const WHATSAPP_DEFAULT_REMOVE_ON_FAIL = 50;
export const WHATSAPP_OUTBOX_MAX_ATTEMPTS = 5;
export const WHATSAPP_OUTBOX_BASE_RETRY_MS = 5_000;
export const WHATSAPP_AI_SEARCH_TIMEOUT_MS = 8_000;
export const WHATSAPP_CAR_SEARCH_TIMEOUT_MS = 8_000;
export const WHATSAPP_MAX_SEARCH_MESSAGE_CHARS = 1_200;
export const WHATSAPP_SEARCH_SLOT_TTL_SECONDS = 24 * 60 * 60;
export const WHATSAPP_SEARCH_SLOT_FRESH_INTENT_WINDOW_SECONDS = 60 * 60;

export const WHATSAPP_QUEUE_DEFAULT_JOB_OPTIONS: Pick<
  JobsOptions,
  "attempts" | "backoff" | "removeOnComplete" | "removeOnFail"
> = {
  attempts: WHATSAPP_DEFAULT_JOB_ATTEMPTS,
  backoff: { type: "exponential", delay: WHATSAPP_DEFAULT_BACKOFF_MS },
  removeOnComplete: WHATSAPP_DEFAULT_REMOVE_ON_COMPLETE,
  removeOnFail: WHATSAPP_DEFAULT_REMOVE_ON_FAIL,
};

export const WHATSAPP_LOCK_ACQUIRE_MAX_WAIT_MS = WHATSAPP_PROCESSING_LOCK_TTL_MS;
export const WHATSAPP_LOCK_ACQUIRE_INITIAL_BACKOFF_MS = 200;
export const WHATSAPP_LOCK_ACQUIRE_MAX_BACKOFF_MS = 2_000;
export const WHATSAPP_LOCK_ACQUIRE_JITTER_MS = 150;

export const WHATSAPP_OUTBOX_QUEUE_JOB_OPTIONS: Pick<
  JobsOptions,
  "attempts" | "backoff" | "removeOnComplete" | "removeOnFail"
> = {
  ...WHATSAPP_QUEUE_DEFAULT_JOB_OPTIONS,
  attempts: WHATSAPP_OUTBOX_MAX_ATTEMPTS,
  backoff: { type: "exponential", delay: WHATSAPP_OUTBOX_BASE_RETRY_MS },
};

export function computeOutboxRetryDelayMs(attemptsMade: number): number {
  const cappedAttempts = Math.max(1, Math.min(attemptsMade, WHATSAPP_OUTBOX_MAX_ATTEMPTS));
  const delay = WHATSAPP_OUTBOX_BASE_RETRY_MS * 2 ** (cappedAttempts - 1);
  // Cap at 15 minutes per retry window.
  return Math.min(delay, 15 * 60 * 1000);
}
