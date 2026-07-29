export function stripQueryString(url?: string): string | undefined {
  return url?.split("?", 1)[0];
}
