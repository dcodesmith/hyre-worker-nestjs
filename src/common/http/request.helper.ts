import type { Request } from "express";

export function getRequestOrigin(request: Pick<Request, "headers" | "protocol" | "get">): string {
  const forwardedProto = request.headers["x-forwarded-proto"];
  const protocol =
    typeof forwardedProto === "string" && forwardedProto.length > 0
      ? forwardedProto.split(",")[0].trim()
      : request.protocol;
  const host = request.get("host");
  return `${protocol}://${host}`;
}
