import type { ExecutionContext } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { OptionalSessionGuard } from "../auth/guards/optional-session.guard";
import { BookingReceiptAccessGuard } from "./booking-receipt-access.guard";

function context(headers: Record<string, string>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

describe("BookingReceiptAccessGuard", () => {
  it("lets the receipt service validate a supplied guest token without session downgrade", async () => {
    const optionalSessionGuard = { canActivate: vi.fn() };
    const guard = new BookingReceiptAccessGuard(
      optionalSessionGuard as unknown as OptionalSessionGuard,
    );

    expect(await guard.canActivate(context({ "x-guest-booking-token": "token" }))).toBe(true);
    expect(optionalSessionGuard.canActivate).not.toHaveBeenCalled();
  });

  it("delegates to optional session validation when the guest header is absent", async () => {
    const optionalSessionGuard = { canActivate: vi.fn().mockResolvedValue(true) };
    const guard = new BookingReceiptAccessGuard(
      optionalSessionGuard as unknown as OptionalSessionGuard,
    );
    const executionContext = context({});

    expect(await guard.canActivate(executionContext)).toBe(true);
    expect(optionalSessionGuard.canActivate).toHaveBeenCalledWith(executionContext);
  });
});
