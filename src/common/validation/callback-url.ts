import { z } from "zod";

const blockedProtocols = new Set([
  "about:",
  "blob:",
  "chrome:",
  "data:",
  "file:",
  "ftp:",
  "ftps:",
  "javascript:",
  "mailto:",
  "sftp:",
  "sms:",
  "ssh:",
  "tel:",
  "vbscript:",
  "ws:",
  "wss:",
]);

const customSchemePattern = /^[a-z][a-z0-9+.-]*:$/;

export function isAllowedCallbackUrl(value: string, nodeEnv = process.env.NODE_ENV): boolean {
  let protocol: string;
  try {
    protocol = new URL(value).protocol.toLowerCase();
  } catch {
    return false;
  }

  if (protocol === "https:") {
    return true;
  }

  if (protocol === "http:") {
    return nodeEnv !== "production";
  }

  if (blockedProtocols.has(protocol)) {
    return false;
  }

  return customSchemePattern.test(protocol) && value.includes("://");
}

export const callbackUrlSchema = z
  .url("Invalid callback URL")
  .refine((value) => isAllowedCallbackUrl(value), {
    error:
      "Callback URL must use https://, http:// in non-production, or a mobile app deep-link scheme",
  });
