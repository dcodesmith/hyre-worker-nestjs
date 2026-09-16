export const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;

const VIN_PATH_SEGMENT = /\/([A-HJ-NPR-Z0-9]{17})(?=\/|$)/gi;

export function redactVinInUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  const match = /[?#]/.exec(url);
  const path = match ? url.slice(0, match.index) : url;
  const suffix = match ? url.slice(match.index) : "";
  const redactedPath = VIN_PATTERN.test(path)
    ? "[REDACTED]"
    : path.replace(VIN_PATH_SEGMENT, "/[REDACTED]");
  return `${redactedPath}${suffix}`;
}
