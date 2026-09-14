import { randomBytes } from "node:crypto";

export const CAR_PUBLIC_REF_PATTERN = /^[0-9a-f]{16}$/;

export function generateCarPublicRef(): string {
  return randomBytes(8).toString("hex");
}
