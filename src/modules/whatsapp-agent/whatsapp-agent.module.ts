import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { WHATSAPP_AGENT_QUEUE } from "../../config/constants";
import { DatabaseModule } from "../database/database.module";
import { TwilioWebhookGuard } from "../messaging/guards/twilio-webhook.guard";
import { WHATSAPP_DEFAULT_BACKOFF_MS, WHATSAPP_DEFAULT_JOB_ATTEMPTS } from "./whatsapp-agent.const";
import { WhatsAppAgentProcessor } from "./whatsapp-agent.processor";
import { WhatsAppConversationService } from "./whatsapp-conversation.service";
import { WhatsAppInboundController } from "./whatsapp-inbound.controller";
import { WhatsAppIngressService } from "./whatsapp-ingress.service";
import { WhatsAppOrchestratorService } from "./whatsapp-orchestrator.service";
import { WhatsAppSenderService } from "./whatsapp-sender.service";
import { WhatsAppWindowPolicyService } from "./whatsapp-window-policy.service";

@Module({
  imports: [
    DatabaseModule,
    BullModule.registerQueue({
      name: WHATSAPP_AGENT_QUEUE,
      defaultJobOptions: {
        attempts: WHATSAPP_DEFAULT_JOB_ATTEMPTS,
        backoff: {
          type: "exponential",
          delay: WHATSAPP_DEFAULT_BACKOFF_MS,
        },
        removeOnComplete: 100,
        removeOnFail: 50,
      },
    }),
    BullBoardModule.forFeature({
      name: WHATSAPP_AGENT_QUEUE,
      adapter: BullMQAdapter,
    }),
  ],
  controllers: [WhatsAppInboundController],
  providers: [
    WhatsAppIngressService,
    WhatsAppConversationService,
    WhatsAppWindowPolicyService,
    WhatsAppOrchestratorService,
    WhatsAppSenderService,
    WhatsAppAgentProcessor,
    TwilioWebhookGuard,
  ],
  exports: [WhatsAppIngressService, WhatsAppSenderService, BullModule],
})
export class WhatsAppAgentModule {}
