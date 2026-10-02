import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { BullBoardModule } from "@bull-board/nestjs";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { BullModule } from "@nestjs/bullmq";
import { Inject, Module, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { PinoLogger } from "nestjs-pino";
import { WHATSAPP_AGENT_QUEUE } from "../../config/constants";
import type { EnvConfig } from "../../config/env.config";
import { AddonsModule } from "../addons/addons.module";
import { BookingModule } from "../booking/booking.module";
import { CarModule } from "../car/car.module";
import { DatabaseModule } from "../database/database.module";
import { MapsModule } from "../maps/maps.module";
import { TwilioWebhookGuard } from "../messaging/guards/twilio-webhook.guard";
import { OpenAiSdkModule } from "../openai-sdk/openai-sdk.module";
import { PaymentModule } from "../payment/payment.module";
import { RatesModule } from "../rates/rates.module";
import { WHATSAPP_QUEUE_DEFAULT_JOB_OPTIONS } from "./booking-agent.const";
import { BookingAgentOrchestratorService } from "./booking-agent-orchestrator.service";
import { BookingAgentSearchService } from "./booking-agent-search.service";
import { BookingAgentWindowPolicyService } from "./booking-agent-window-policy.service";
import { BookingAgentExtractorService } from "./conversation/booking-agent-extractor.service";
import { BookingAgentResponderService } from "./conversation/booking-agent-responder.service";
import { BookingAgentStateService } from "./conversation/booking-agent-state.service";
import { BookingAgentTurnService } from "./conversation/booking-agent-turn.service";
import {
  BOOKING_AGENT_EXTRACTION_MODEL,
  BOOKING_AGENT_RESPONSE_MODEL,
} from "./conversation/conversation.const";
import {
  BOOKING_AGENT_ANTHROPIC_CLIENT,
  BOOKING_AGENT_OPENAI_CLIENT,
  BOOKING_AGENT_REDIS_CLIENT,
} from "./conversation/conversation.tokens";
import { CreateBookingAction } from "./conversation/create-booking.action";
import { ExtractAction } from "./conversation/extract.action";
import { HandoffAction } from "./conversation/handoff.action";
import { MergeAction } from "./conversation/merge.action";
import { PrepareQuoteAction } from "./conversation/prepare-quote.action";
import { RespondAction } from "./conversation/respond.action";
import { RouteAction } from "./conversation/route.action";
import { SearchAction } from "./conversation/search.action";
import { WhatsAppProcessor } from "./whatsapp/whatsapp.processor";
import { WhatsAppAudioTranscriptionService } from "./whatsapp/whatsapp-audio-transcription.service";
import { WhatsAppInboundController } from "./whatsapp/whatsapp-inbound.controller";
import { WhatsAppIngressService } from "./whatsapp/whatsapp-ingress.service";
import { WhatsAppPersistenceService } from "./whatsapp/whatsapp-persistence.service";
import { WhatsAppSenderService } from "./whatsapp/whatsapp-sender.service";

@Module({
  imports: [
    DatabaseModule,
    AddonsModule,
    BookingModule,
    CarModule,
    MapsModule,
    RatesModule,
    OpenAiSdkModule,
    PaymentModule,
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
      provide: BOOKING_AGENT_ANTHROPIC_CLIENT,
      inject: [ConfigService],
      useFactory: (configService: ConfigService<EnvConfig>) => {
        const apiKey = configService.get("ANTHROPIC_API_KEY", { infer: true });
        return new ChatAnthropic({
          apiKey,
          model: BOOKING_AGENT_RESPONSE_MODEL,
        });
      },
    },
    {
      provide: BOOKING_AGENT_OPENAI_CLIENT,
      inject: [ConfigService],
      useFactory: (configService: ConfigService<EnvConfig>) => {
        const apiKey = configService.get("OPENAI_API_KEY", { infer: true });
        return new ChatOpenAI({
          apiKey,
          model: BOOKING_AGENT_EXTRACTION_MODEL,
        });
      },
    },
    {
      provide: BOOKING_AGENT_REDIS_CLIENT,
      inject: [ConfigService, PinoLogger],
      useFactory: (configService: ConfigService<EnvConfig>, logger: PinoLogger) => {
        logger.setContext("BookingAgentRedisClient");
        const redisUrl = configService.get("REDIS_URL", { infer: true });
        const client = new Redis(redisUrl, {
          maxRetriesPerRequest: 2,
          enableReadyCheck: true,
        });
        client.on("error", (error) => {
          logger.error(
            {
              error: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
            },
            "BOOKING_AGENT_REDIS_CLIENT emitted Redis error",
          );
        });
        return client;
      },
    },
    BookingAgentStateService,
    BookingAgentExtractorService,
    BookingAgentResponderService,
    ExtractAction,
    MergeAction,
    RouteAction,
    SearchAction,
    PrepareQuoteAction,
    CreateBookingAction,
    RespondAction,
    HandoffAction,
    BookingAgentTurnService,
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
export class BookingAgentModule implements OnModuleDestroy {
  constructor(
    @Inject(BOOKING_AGENT_REDIS_CLIENT)
    private readonly redisClient: Redis,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(BookingAgentModule.name);
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redisClient.quit();
    } catch (error) {
      this.logger.warn(
        {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        "Failed to quit BOOKING_AGENT_REDIS_CLIENT, forcing disconnect",
      );
      try {
        this.redisClient.disconnect();
      } catch (disconnectError) {
        this.logger.error(
          {
            error:
              disconnectError instanceof Error ? disconnectError.message : String(disconnectError),
            stack: disconnectError instanceof Error ? disconnectError.stack : undefined,
          },
          "Failed to disconnect BOOKING_AGENT_REDIS_CLIENT",
        );
      }
    }
  }
}
