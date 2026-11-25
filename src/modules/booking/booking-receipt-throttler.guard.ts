import { Injectable } from "@nestjs/common";
import { ClientIpThrottlerGuard } from "../../common/throttling/client-ip-throttler.guard";

@Injectable()
export class BookingReceiptThrottlerGuard extends ClientIpThrottlerGuard {
  async onModuleInit(): Promise<void> {
    await super.onModuleInit();
    const defaultThrottler = this.throttlers.find(({ name }) => name === "default");
    if (!defaultThrottler) throw new Error("Missing default throttler configuration");
    this.throttlers = [defaultThrottler];
  }
}
