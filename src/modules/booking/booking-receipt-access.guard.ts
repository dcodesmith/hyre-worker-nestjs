import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { OptionalSessionGuard } from "../auth/guards/optional-session.guard";

@Injectable()
export class BookingReceiptAccessGuard implements CanActivate {
  constructor(private readonly optionalSessionGuard: OptionalSessionGuard) {}

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    if (this.hasGuestToken(request.headers["x-guest-booking-token"])) return true;
    return this.optionalSessionGuard.canActivate(context);
  }

  private hasGuestToken(value: string | string[] | undefined): value is string {
    return typeof value === "string" && value.trim() !== "";
  }
}
