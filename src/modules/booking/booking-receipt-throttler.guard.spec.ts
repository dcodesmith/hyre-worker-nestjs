import { Reflector } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import { ThrottlerStorage } from "@nestjs/throttler";
import { describe, expect, it, vi } from "vitest";
import { BookingReceiptThrottlerGuard } from "./booking-receipt-throttler.guard";

class TestableBookingReceiptThrottlerGuard extends BookingReceiptThrottlerGuard {
  getThrottlerNames(): Array<string | undefined> {
    return this.throttlers.map(({ name }) => name);
  }
}

describe("BookingReceiptThrottlerGuard", () => {
  it("evaluates only the default profile", async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TestableBookingReceiptThrottlerGuard,
        {
          provide: "THROTTLER:MODULE_OPTIONS",
          useValue: [
            { name: "default", ttl: 60_000, limit: 10 },
            { name: "ai-search-public", ttl: 60_000, limit: 1 },
          ],
        },
        { provide: ThrottlerStorage, useValue: { increment: vi.fn(), get: vi.fn() } },
        Reflector,
      ],
    }).compile();
    const guard = module.get(TestableBookingReceiptThrottlerGuard);

    await guard.onModuleInit();

    expect(guard.getThrottlerNames()).toEqual(["default"]);
  });
});
