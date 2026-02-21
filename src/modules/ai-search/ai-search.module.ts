import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AiSearchController } from "./ai-search.controller";
import { AiSearchService } from "./ai-search.service";
import { OpenAiAiSearchExtractorService } from "./openai-ai-search-extractor.service";

@Module({
  imports: [ConfigModule],
  controllers: [AiSearchController],
  providers: [AiSearchService, OpenAiAiSearchExtractorService],
  exports: [AiSearchService],
})
export class AiSearchModule {}
