import type { Request } from "express";

type RequestOriginRequest = Pick<Request, "headers" | "protocol" | "get"> & {
  app?: Pick<Request["app"], "get">;
};

const ALLOWED_PROTOCOLS = new Set(["http", "https"]);
const DEFAULT_ALLOWED_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

function asAllowedOrigin(rawOrigin: string | undefined): string | null {
  if (!rawOrigin || rawOrigin.trim().length === 0) {
    return null;
  }

  try {
    const parsed = new URL(rawOrigin.trim());
    const protocol = parsed.protocol.replace(":", "").toLowerCase();

    if (!ALLOWED_PROTOCOLS.has(protocol)) {
      return null;
    }

    return `${protocol}://${parsed.host.toLowerCase()}`;
  } catch {
    return null;
  }
}

function getConfiguredOrigins(): string[] {
  const configuredAuthOrigin = asAllowedOrigin(process.env.AUTH_BASE_URL);
  const configuredTrustedOrigins = (process.env.TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((origin) => asAllowedOrigin(origin))
    .filter((origin): origin is string => origin !== null);

  return configuredAuthOrigin
    ? [configuredAuthOrigin, ...configuredTrustedOrigins]
    : configuredTrustedOrigins;
}

function getTrustedHostAllowlist(configuredOrigins: string[]): Set<string> {
  const allowlist = new Set<string>();

  for (const configuredOrigin of configuredOrigins) {
    try {
      const parsedOrigin = new URL(configuredOrigin);
      allowlist.add(parsedOrigin.host.toLowerCase());
      allowlist.add(parsedOrigin.hostname.toLowerCase());
    } catch {
      // Invalid entries are ignored by design.
    }
  }

  for (const hostname of DEFAULT_ALLOWED_HOSTNAMES) {
    allowlist.add(hostname);
  }

  return allowlist;
}

function isExpressTrustProxyEnabled(request: RequestOriginRequest): boolean {
  const trustProxyValue = request.app?.get?.("trust proxy");

  if (typeof trustProxyValue === "function") {
    return true;
  }

  if (typeof trustProxyValue === "number") {
    return trustProxyValue > 0;
  }

  if (typeof trustProxyValue === "string") {
    const normalizedValue = trustProxyValue.trim().toLowerCase();
    return normalizedValue.length > 0 && normalizedValue !== "0" && normalizedValue !== "false";
  }

  return Boolean(trustProxyValue);
}

function parseRequestHost(
  request: RequestOriginRequest,
): { host: string; hostname: string } | null {
  const rawHost = request.get("host");

  if (!rawHost || rawHost.trim().length === 0) {
    return null;
  }

  try {
    const parsed = new URL(`http://${rawHost.trim()}`);
    return {
      host: parsed.host.toLowerCase(),
      hostname: parsed.hostname.toLowerCase(),
    };
  } catch {
    return null;
  }
}

function getValidatedProtocol(request: RequestOriginRequest): string | null {
  const baseProtocol = request.protocol?.trim().toLowerCase();
  const protocolFromRequest = ALLOWED_PROTOCOLS.has(baseProtocol) ? baseProtocol : null;

  if (!isExpressTrustProxyEnabled(request)) {
    return protocolFromRequest;
  }

  const forwardedProtoHeader = request.headers["x-forwarded-proto"];
  const forwardedProto = Array.isArray(forwardedProtoHeader)
    ? forwardedProtoHeader[0]
    : forwardedProtoHeader;
  const sanitizedForwardedProto = forwardedProto?.split(",")[0]?.trim().toLowerCase();

  if (sanitizedForwardedProto && ALLOWED_PROTOCOLS.has(sanitizedForwardedProto)) {
    return sanitizedForwardedProto;
  }

  return protocolFromRequest;
}

export function getRequestOrigin(request: RequestOriginRequest): string | null {
  const configuredOrigins = getConfiguredOrigins();
  if (configuredOrigins.length > 0) {
    return configuredOrigins[0];
  }

  const protocol = getValidatedProtocol(request);
  if (!protocol) {
    return null;
  }

  const host = parseRequestHost(request);
  if (!host) {
    return null;
  }

  const trustedHosts = getTrustedHostAllowlist(configuredOrigins);
  const isTrustedHost = trustedHosts.has(host.host) || trustedHosts.has(host.hostname);
  if (!isTrustedHost) {
    return null;
  }

  return `${protocol}://${host.host}`;
}
