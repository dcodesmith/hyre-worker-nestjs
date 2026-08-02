import { describe, expect, it, vi } from "vitest";
import { getDatabaseNow } from "./booking-modification-policy.helper";

describe("getDatabaseNow", () => {
  it("returns PostgreSQL wall-clock time", async () => {
    const policyNow = new Date("2026-08-02T14:00:00.000Z");
    const database = {
      $queryRaw: vi.fn().mockResolvedValue([{ policyNow }]),
    };

    await expect(getDatabaseNow(database)).resolves.toEqual(policyNow);
    expect(database.$queryRaw).toHaveBeenCalledOnce();
  });
});
