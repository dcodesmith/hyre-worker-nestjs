import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { WHATSAPP_AGENT_QUEUE } from "../../config/constants";
import { AiSearchModule } from "../ai-search/ai-search.module";
import { CarModule } from "../car/car.module";
import { DatabaseModule } from "../database/database.module";
import { TwilioWebhookGuard } from "../messaging/guards/twilio-webhook.guard";
import { RatesModule } from "../rates/rates.module";
import { WHATSAPP_QUEUE_DEFAULT_JOB_OPTIONS } from "./whatsapp-agent.const";
import { WhatsAppAgentProcessor } from "./whatsapp-agent.processor";
import { WhatsAppConversationService } from "./whatsapp-conversation.service";
import { WhatsAppFollowupQuestionService } from "./whatsapp-followup-question.service";
import { WhatsAppInboundController } from "./whatsapp-inbound.controller";
import { WhatsAppIngressService } from "./whatsapp-ingress.service";
import { WhatsAppOrchestratorService } from "./whatsapp-orchestrator.service";
import { WhatsAppSearchSlotMemoryService } from "./whatsapp-search-slot-memory.service";
import { WhatsAppSenderService } from "./whatsapp-sender.service";
import { WhatsAppToolExecutorService } from "./whatsapp-tool-executor.service";
import { WhatsAppWindowPolicyService } from "./whatsapp-window-policy.service";

@Module({
  imports: [
    DatabaseModule,
    AiSearchModule,
    CarModule,
    RatesModule,
    BullModule.registerQueue({
      name: WHATSAPP_AGENT_QUEUE,
      defaultJobOptions: WHATSAPP_QUEUE_DEFAULT_JOB_OPTIONS,
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
    WhatsAppFollowupQuestionService,
    WhatsAppSearchSlotMemoryService,
    WhatsAppOrchestratorService,
    WhatsAppToolExecutorService,
    WhatsAppSenderService,
    WhatsAppAgentProcessor,
    TwilioWebhookGuard,
  ],
  exports: [WhatsAppIngressService, WhatsAppSenderService, BullModule],
})
export class WhatsAppAgentModule {}
