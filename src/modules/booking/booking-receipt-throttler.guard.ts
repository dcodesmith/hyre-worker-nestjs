import { Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";

@Injectable()
export class BookingReceiptThrottlerGuard extends ThrottlerGuard {
  async onModuleInit(): Promise<void> {
    await super.onModuleInit();
    const defaultThrottler = this.throttlers.find(({ name }) => name === "default");
    if (!defaultThrottler) throw new Error("Missing default throttler configuration");
    this.throttlers = [defaultThrottler];
  }
}
