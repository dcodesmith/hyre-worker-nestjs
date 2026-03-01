import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { BullBoardModule } from "@bull-board/nestjs";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { WHATSAPP_AGENT_QUEUE } from "../../config/constants";
import type { EnvConfig } from "../../config/env.config";
import { BookingModule } from "../booking/booking.module";
import { CarModule } from "../car/car.module";
import { DatabaseModule } from "../database/database.module";
import { TwilioWebhookGuard } from "../messaging/guards/twilio-webhook.guard";
import { OpenAiSdkModule } from "../openai-sdk/openai-sdk.module";
import { RatesModule } from "../rates/rates.module";
import { WHATSAPP_QUEUE_DEFAULT_JOB_OPTIONS } from "./booking-agent.const";
import { BookingAgentOrchestratorService } from "./booking-agent-orchestrator.service";
import { BookingAgentSearchService } from "./booking-agent-search.service";
import { BookingAgentWindowPolicyService } from "./booking-agent-window-policy.service";
import { LANGGRAPH_EXTRACTION_MODEL, LANGGRAPH_RESPONSE_MODEL } from "./langgraph/langgraph.const";
import {
  LANGGRAPH_ANTHROPIC_CLIENT,
  LANGGRAPH_OPENAI_CLIENT,
  LANGGRAPH_REDIS_CLIENT,
} from "./langgraph/langgraph.tokens";
import { LangGraphExtractorService } from "./langgraph/langgraph-extractor.service";
import { LangGraphGraphService } from "./langgraph/langgraph-graph.service";
import { LangGraphResponderService } from "./langgraph/langgraph-responder.service";
import { LangGraphStateService } from "./langgraph/langgraph-state.service";
import { WhatsAppProcessor } from "./whatsapp/whatsapp.processor";
import { WhatsAppAudioTranscriptionService } from "./whatsapp/whatsapp-audio-transcription.service";
import { WhatsAppInboundController } from "./whatsapp/whatsapp-inbound.controller";
import { WhatsAppIngressService } from "./whatsapp/whatsapp-ingress.service";
import { WhatsAppPersistenceService } from "./whatsapp/whatsapp-persistence.service";
import { WhatsAppSenderService } from "./whatsapp/whatsapp-sender.service";

@Module({
  imports: [
    DatabaseModule,
    BookingModule,
    CarModule,
    RatesModule,
    OpenAiSdkModule,
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
    {
      provide: LANGGRAPH_ANTHROPIC_CLIENT,
      inject: [ConfigService],
      useFactory: (configService: ConfigService<EnvConfig>) => {
        const apiKey = configService.get("ANTHROPIC_API_KEY", { infer: true });
        return new ChatAnthropic({
          apiKey,
          model: LANGGRAPH_RESPONSE_MODEL,
        });
      },
    },
    {
      provide: LANGGRAPH_OPENAI_CLIENT,
      inject: [ConfigService],
      useFactory: (configService: ConfigService<EnvConfig>) => {
        const apiKey = configService.get("OPENAI_API_KEY", { infer: true });
        return new ChatOpenAI({
          apiKey,
          model: LANGGRAPH_EXTRACTION_MODEL,
        });
      },
    },
    {
      provide: LANGGRAPH_REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (configService: ConfigService<EnvConfig>) => {
        const redisUrl = configService.get("REDIS_URL", { infer: true });
        return new Redis(redisUrl, {
          maxRetriesPerRequest: 2,
          enableReadyCheck: true,
        });
      },
    },
    LangGraphStateService,
    LangGraphExtractorService,
    LangGraphResponderService,
    LangGraphGraphService,
    WhatsAppIngressService,
    WhatsAppAudioTranscriptionService,
    WhatsAppPersistenceService,
    BookingAgentWindowPolicyService,
    BookingAgentOrchestratorService,
    BookingAgentSearchService,
    WhatsAppSenderService,
    WhatsAppProcessor,
    TwilioWebhookGuard,
  ],
  exports: [
    WhatsAppIngressService,
    WhatsAppSenderService,
    BookingAgentSearchService,
    BookingAgentWindowPolicyService,
    BullModule,
  ],
})
export class BookingAgentModule {}
