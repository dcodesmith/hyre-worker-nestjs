import { describe, expect, it } from "vitest";
import { PINO_REDACT_PATHS } from "./pino-redact.const";

describe("PINO_REDACT_PATHS", () => {
  it("includes destinationAddress at the root and one level down", () => {
    expect(PINO_REDACT_PATHS).toContain("destinationAddress");
    expect(PINO_REDACT_PATHS).toContain("*.destinationAddress");
  });
});
