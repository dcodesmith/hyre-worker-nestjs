import { Body, Controller, Header, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { TwilioWebhookGuard } from "../../messaging/guards/twilio-webhook.guard";
import { WHATSAPP_AGENT_ACK_XML } from "../booking-agent.const";
import type { TwilioInboundWebhookPayload } from "../booking-agent.interface";
import { WhatsAppIngressService } from "./whatsapp-ingress.service";

@Controller("api/whatsapp-agent")
export class WhatsAppInboundController {
  constructor(private readonly whatsappIngressService: WhatsAppIngressService) {}

  @Post("webhook/twilio")
  @HttpCode(HttpStatus.OK)
  @Header("Content-Type", "application/xml")
  @UseGuards(TwilioWebhookGuard)
  async handleWebhook(@Body() payload: TwilioInboundWebhookPayload): Promise<string> {
    await this.whatsappIngressService.handleInbound(payload);
    return WHATSAPP_AGENT_ACK_XML;
  }
}
