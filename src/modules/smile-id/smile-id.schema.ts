import { z } from "zod";

export const smileIdTokenResponseSchema = z.object({
  token: z.string().min(1),
});

export const smileIdCompareWebhookSchema = z.object({
  status: z.enum(["clear", "attention", "block", "error"]),
  product: z.literal("smart_selfie_compare"),
  partner_params: z.object({
    job_id: z.string().min(1),
    verificationId: z.string().min(1),
    stageRequestId: z.string().min(1),
  }),
});

export const smileIdJobStatusSchema = z.object({
  status: z.enum(["clear", "block", "attention", "error", "processing", "not_found"]),
  job_id: z.string().min(1),
});

export const smileIdAcceptedResponseSchema = z.object({
  status: z.literal("Accepted"),
  message: z.string().optional(),
  job_id: z.string().min(1),
  user_id: z.string().optional(),
  created_at: z.string().optional(),
});
