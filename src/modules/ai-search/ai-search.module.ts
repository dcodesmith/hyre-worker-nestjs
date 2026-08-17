import { Module } from "@nestjs/common";
import { ThrottlerModule } from "@nestjs/throttler";
import { OpenAiSdkModule } from "../openai-sdk/openai-sdk.module";
import { AiSearchController } from "./ai-search.controller";
import { AiSearchService } from "./ai-search.service";
import { AiSearchThrottlerGuard } from "./ai-search-throttler.guard";
import { OpenAiAiSearchExtractorService } from "./openai-ai-search-extractor.service";

@Module({
  imports: [OpenAiSdkModule, ThrottlerModule],
  controllers: [AiSearchController],
  providers: [AiSearchService, OpenAiAiSearchExtractorService, AiSearchThrottlerGuard],
  exports: [AiSearchService],
})
export class AiSearchModule {}
