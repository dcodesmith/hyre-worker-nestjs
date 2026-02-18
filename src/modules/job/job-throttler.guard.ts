import { ExecutionContext, Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import { computeRetryAfterEpoch } from "../../common/throttling/throttling.helper";
import { JobRateLimitExceededException } from "./errors";

/**
 * Custom throttler guard that includes the jobType parameter in the tracking key
 * and throws custom JobException with error codes when rate limit is exceeded.
 *
 * Features:
 * - Each job type has its own independent rate limit
 * - Throws JobException with JOB.RATE_LIMIT.EXCEEDED error code
 * - Includes job type and retryAfter timestamp in error details
 *
 * Example:
 * - /job/trigger/start-reminders → tracked separately from
 * - /job/trigger/end-reminders
 *
 * Without this, all job types would share the same rate limit since they
 * use the same route pattern (/job/trigger/:jobType)
 */
@Injectable()
export class JobThrottlerGuard extends ThrottlerGuard {
  /**
   * Override to generate a unique tracking key that includes the jobType parameter.
   * This allows each job type to have independent rate limiting.
   */
  protected generateKey(context: ExecutionContext, suffix: string, name: string): string {
    const request = context.switchToHttp().getRequest<{ params?: { jobType?: string } }>();
    const jobType = request.params?.jobType;

    // Include jobType in the key to ensure separate limits per job type
    // Format: {throttlerName}-{jobType}-{tracker}
    // Example: "manual-triggers-start-reminders-127.0.0.1"
    const key = jobType ? `${name}-${jobType}` : name;

    return `${key}-${suffix}`;
  }

  /**
   * Override to throw custom JobException with error code instead of generic ThrottlerException.
   * This ensures consistent error format with error codes across the application.
   * Includes retryAfter timestamp indicating when the rate limit resets.
   */
  protected async throwThrottlingException(
    context: ExecutionContext,
    throttlerConfig?: { ttl: number },
  ): Promise<void> {
    const request = context.switchToHttp().getRequest<{ params?: { jobType?: string } }>();
    const jobType = request.params?.jobType || "unknown";

    // Calculate retryAfter: TTL seconds from now (when rate limit resets)
    // Default to 3600 seconds (1 hour) if not provided
    const ttlSeconds = throttlerConfig?.ttl || 3600;
    const retryAfter = computeRetryAfterEpoch(ttlSeconds);

    throw new JobRateLimitExceededException(jobType, retryAfter);
  }
}
