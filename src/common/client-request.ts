import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { isIP } from "node:net";

export const EDGE_HEADER = "x-hyre-edge";
export const CLIENT_IP_HEADER = "x-hyre-client-ip";
export const CLIENT_COUNTRY_HEADER = "x-hyre-country";

const USER_AGENT_MAX = 512;
const IGNORED_COUNTRIES = new Set(["XX", "T1"]);

export type ClientRequestContext = {
  ipAddress: string | null;
  userAgent: string | null;
  country: string | null;
};

export type StoredClientContext = {
  ipAddress?: string | null;
  userAgent?: string | null;
  country?: string | null;
};

type PublicSessionResponse<T> = T extends { session?: infer Session }
  ? Omit<T, "session"> & {
      session: Session extends StoredClientContext | null | undefined
        ? Omit<NonNullable<Session>, keyof StoredClientContext> | Extract<Session, null | undefined>
        : Session;
    }
  : T;

type HeaderSource = IncomingHttpHeaders | Headers | undefined;

export function readClientRequest(
  headers: HeaderSource,
  edgeSecret: string | undefined,
): ClientRequestContext {
  const trusted = edgeSecret !== undefined && headerMatches(headers, EDGE_HEADER, edgeSecret);
  const ipAddress = singleIp(headerValue(headers, trusted ? "cf-connecting-ip" : "fly-client-ip"));
  const country = trusted ? countryCode(headerValue(headers, "cf-ipcountry")) : null;
  const userAgent = bounded(headerValue(headers, "user-agent"), USER_AGENT_MAX);

  return { ipAddress, userAgent, country };
}

export function stampClientHeaders(
  headers: IncomingHttpHeaders,
  edgeSecret: string | undefined,
): ClientRequestContext {
  const context = readClientRequest(headers, edgeSecret);
  if (context.ipAddress) {
    headers[CLIENT_IP_HEADER] = context.ipAddress;
  } else {
    delete headers[CLIENT_IP_HEADER];
  }
  if (context.country) {
    headers[CLIENT_COUNTRY_HEADER] = context.country;
  } else {
    delete headers[CLIENT_COUNTRY_HEADER];
  }
  return context;
}

export function countryFromHeaders(headers: HeaderSource): string | null {
  return countryCode(headerValue(headers, CLIENT_COUNTRY_HEADER));
}

export function omitStoredClientContext<T extends object>(
  value: T,
): Omit<T, keyof StoredClientContext> {
  const {
    ipAddress: _ipAddress,
    userAgent: _userAgent,
    country: _country,
    ...rest
  } = value as T & StoredClientContext;
  return rest;
}

export function withoutSessionClientContext<T extends object>(value: T): PublicSessionResponse<T> {
  const response = value as T & { session?: StoredClientContext | null };
  if (!response.session || !hasStoredClientContext(response.session)) {
    return value as PublicSessionResponse<T>;
  }

  return {
    ...response,
    session: omitStoredClientContext(response.session),
  } as PublicSessionResponse<T>;
}

function hasStoredClientContext(session: StoredClientContext): boolean {
  return "ipAddress" in session || "userAgent" in session || "country" in session;
}

function headerMatches(headers: HeaderSource, name: string, expected: string): boolean {
  const actual = headerValue(headers, name);
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function headerValue(headers: HeaderSource, name: string): string | undefined {
  if (!headers) return undefined;
  const value = headers instanceof Headers ? headers.get(name) : headers[name];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

function singleIp(value: string | undefined): string | null {
  const ip = value?.split(",")[0]?.trim();
  return ip && isIP(ip) ? ip : null;
}

function countryCode(value: string | undefined): string | null {
  const code = value?.trim().toUpperCase();
  if (!code || code.length !== 2 || IGNORED_COUNTRIES.has(code)) return null;
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

function bounded(value: string | undefined, max: number): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}
