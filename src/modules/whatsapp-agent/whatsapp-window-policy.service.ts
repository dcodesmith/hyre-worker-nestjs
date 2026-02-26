import { Injectable } from "@nestjs/common";
import { WhatsAppDeliveryMode } from "@prisma/client";
import { WHATSAPP_SERVICE_WINDOW_HOURS } from "./whatsapp-agent.const";

@Injectable()
export class WhatsAppWindowPolicyService {
  private readonly windowDurationMs = WHATSAPP_SERVICE_WINDOW_HOURS * 60 * 60 * 1000;

  computeWindowExpiry(from: Date): Date {
    return new Date(from.getTime() + this.windowDurationMs);
  }

  isWindowOpen(windowExpiresAt: Date | null | undefined, now = new Date()): boolean {
    if (!windowExpiresAt) {
      return false;
    }
    return windowExpiresAt.getTime() > now.getTime();
  }

  resolveOutboundMode(windowExpiresAt: Date | null | undefined): WhatsAppDeliveryMode {
    return this.isWindowOpen(windowExpiresAt)
      ? WhatsAppDeliveryMode.FREE_FORM
      : WhatsAppDeliveryMode.TEMPLATE;
  }
}
