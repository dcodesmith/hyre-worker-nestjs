import { z } from "zod";

const expoPushTokenPattern = /^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/;

export const registerPushTokenBodySchema = z.object({
  token: z
    .string()
    .min(1, "Push token is required")
    .regex(expoPushTokenPattern, "Invalid Expo push token format"),
  platform: z.enum(["ios", "android"]),
});

export type RegisterPushTokenBodyDto = z.infer<typeof registerPushTokenBodySchema>;

export const pushTokenParamSchema = z
  .string()
  .min(1, "Push token is required")
  .regex(expoPushTokenPattern, "Invalid Expo push token format");

export const revokePushTokenBodySchema = z.object({
  token: pushTokenParamSchema,
});

export type RevokePushTokenBodyDto = z.infer<typeof revokePushTokenBodySchema>;
