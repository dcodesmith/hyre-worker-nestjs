import { z } from "zod";
import { getDevLanOriginPatterns, isOriginAllowed } from "../../modules/auth/origin-pattern";

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

const DEFAULT_MOBILE_SCHEMES = new Set(["hyremobile:", "hyreapp:", "tripdly:"]);
const DEV_MOBILE_SCHEMES = new Set(["exp:"]);
const customSchemePattern = /^[a-z][a-z0-9+.-]*:$/;

export interface CallbackUrlEnv {
  APP_ENV?: string;
  TRUSTED_ORIGINS?: string;
  WEBSITE_URL?: string;
  LOCAL_WEB_ORIGINS?: string;
}

function isDevelopmentAppEnv(nodeEnv: string | undefined, env: CallbackUrlEnv): boolean {
  if (env.APP_ENV) {
    return env.APP_ENV === "development";
  }
  return nodeEnv === "development" || nodeEnv === "test";
}

function splitCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getAllowedHttpOriginPatterns(nodeEnv: string | undefined, env: CallbackUrlEnv): string[] {
  const patterns: string[] = [];

  for (const entry of splitCsv(env.TRUSTED_ORIGINS)) {
    if (entry.startsWith("http://") || entry.startsWith("https://")) {
      patterns.push(entry);
    }
  }

  const websiteUrl = env.WEBSITE_URL?.trim();
  if (websiteUrl && (websiteUrl.startsWith("http://") || websiteUrl.startsWith("https://"))) {
    patterns.push(websiteUrl);
  }

  if (isDevelopmentAppEnv(nodeEnv, env)) {
    patterns.push(...splitCsv(env.LOCAL_WEB_ORIGINS));
    if (nodeEnv === "development" || nodeEnv === "test") {
      patterns.push(...getDevLanOriginPatterns(nodeEnv));
    }
    if (nodeEnv === "test") {
      patterns.push("http://localhost:*", "http://127.0.0.1:*");
    }
  }

  return patterns;
}

function getAllowedMobileSchemes(nodeEnv: string | undefined, env: CallbackUrlEnv): Set<string> {
  const schemes = new Set(DEFAULT_MOBILE_SCHEMES);
  if (isDevelopmentAppEnv(nodeEnv, env)) {
    for (const scheme of DEV_MOBILE_SCHEMES) {
      schemes.add(scheme);
    }
  }
  for (const entry of splitCsv(env.TRUSTED_ORIGINS)) {
    const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(entry);
    if (!schemeMatch) continue;
    const protocol = `${schemeMatch[1].toLowerCase()}:`;
    if (protocol !== "http:" && protocol !== "https:" && !blockedProtocols.has(protocol)) {
      schemes.add(protocol);
    }
  }
  return schemes;
}

export function isAllowedCallbackUrl(
  value: string,
  nodeEnv = process.env.NODE_ENV,
  env: CallbackUrlEnv = process.env,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if (parsed.username || parsed.password) {
    return false;
  }

  const protocol = parsed.protocol.toLowerCase();

  if (protocol === "https:" || protocol === "http:") {
    if (protocol === "http:") {
      if (!isDevelopmentAppEnv(nodeEnv, env)) {
        return false;
      }
      if (nodeEnv === "production") {
        return isOriginAllowed(parsed.origin, splitCsv(env.LOCAL_WEB_ORIGINS));
      }
    }

    const allowedOrigins = getAllowedHttpOriginPatterns(nodeEnv, env);
    return isOriginAllowed(parsed.origin, allowedOrigins);
  }

  if (blockedProtocols.has(protocol)) {
    return false;
  }

  return (
    customSchemePattern.test(protocol) &&
    value.includes("://") &&
    getAllowedMobileSchemes(nodeEnv, env).has(protocol)
  );
}

export const callbackUrlSchema = z
  .url("Invalid callback URL")
  .refine((value) => isAllowedCallbackUrl(value), {
    error:
      "Callback URL must use a trusted origin (https://, or http:// in non-production) or an allowed mobile app deep-link scheme",
  });
