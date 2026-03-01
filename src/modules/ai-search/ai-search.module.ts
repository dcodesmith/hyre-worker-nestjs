import { Module } from "@nestjs/common";
import { OpenAiSdkModule } from "../openai-sdk/openai-sdk.module";
import { AiSearchController } from "./ai-search.controller";
import { AiSearchService } from "./ai-search.service";
import { OpenAiAiSearchExtractorService } from "./openai-ai-search-extractor.service";

@Module({
  imports: [OpenAiSdkModule],
  controllers: [AiSearchController],
  providers: [AiSearchService, OpenAiAiSearchExtractorService],
  exports: [AiSearchService],
})
export class AiSearchModule {}
