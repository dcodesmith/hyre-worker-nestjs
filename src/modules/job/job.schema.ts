import { z } from "zod";

/**
 * Zod schema for valid job types that can be triggered
 */
export const JobTypeSchema = z.enum([
  "start-reminders",
  "end-reminders",
  "activate-bookings",
  "complete-bookings",
]);

/**
 * TypeScript type inferred from the Zod schema
 * This ensures compile-time type safety
 */
export type JobType = z.infer<typeof JobTypeSchema>;

/**
 * Friendly names for job types used in response messages
 */
export const JobTypeNames: Record<JobType, string> = {
  "start-reminders": "Start reminder",
  "end-reminders": "End reminder",
  "activate-bookings": "Activate bookings",
  "complete-bookings": "Complete bookings",
};
