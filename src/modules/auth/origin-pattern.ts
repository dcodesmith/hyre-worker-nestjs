/**
 * Helpers for matching request origins against an allow-list that may contain
 * either exact origins (e.g. `https://app.example.com`) or wildcard glob
 * patterns (e.g. `http://192.168.*.*:*`).
 *
 * The wildcard semantics intentionally mirror Better Auth's own
 * `matchesOriginPattern` (see `better-auth/dist/auth/trusted-origins.mjs`):
 *
 *   - `*` matches any sequence of characters (including `.` and `:`).
 *   - `?` matches exactly one character.
 *
 * This lets us share a single allow-list between Better Auth's origin check,
 * NestJS-side role validation (`AuthService.isTrustedOrigin`), and the CORS
 * middleware in `main.ts`.
 */

const RFC1918_DEV_PATTERNS = [
  // Loopback (any port — devs use 3000, 5173, 19000, etc.)
  "http://localhost:*",
  "http://127.0.0.1:*",
  // RFC1918 private ranges — only valid inside a LAN, so safe in dev.
  // 172.* is broader than 172.16.0.0/12 but the alternative is 16 patterns
  // and the looseness is constrained to local network reachability anyway.
  "http://10.*.*.*:*",
  "http://172.*.*.*:*",
  "http://192.168.*.*:*",
] as const;

/**
 * Returns the set of additional origin patterns that should be trusted only
 * during local development. Returns an empty array for any non-development
 * environment so production/preview builds remain locked down to the
 * explicitly configured `TRUSTED_ORIGINS`.
 */
export function getDevLanOriginPatterns(nodeEnv: string | undefined): string[] {
  return nodeEnv === "development" ? [...RFC1918_DEV_PATTERNS] : [];
}

/**
 * Tests whether a candidate origin string matches a pattern. Patterns without
 * `*` or `?` are compared as exact origins (protocol://host[:port]); patterns
 * with wildcards are converted into a strict, anchored regex.
 */
export function originMatchesPattern(origin: string, pattern: string): boolean {
  const candidate = toOrigin(origin);
  if (!candidate) {
    return false;
  }

  if (!pattern.includes("*") && !pattern.includes("?")) {
    const normalizedPattern = toOrigin(pattern) ?? pattern;
    return normalizedPattern === candidate;
  }

  const escaped = pattern.replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`);
  const regexSource = escaped.replaceAll("*", ".*").replaceAll("?", ".");

  try {
    return new RegExp(`^${regexSource}$`).test(candidate);
  } catch {
    return false;
  }
}

/**
 * Returns true when `origin` matches any pattern in `patterns`.
 */
export function isOriginAllowed(origin: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => originMatchesPattern(origin, pattern));
}

function toOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
