import { Module } from "@nestjs/common";
import { AnalyticsIngestionService } from "./analytics-ingestion.service";

@Module({
  providers: [AnalyticsIngestionService],
  exports: [AnalyticsIngestionService],
})
export class AnalyticsModule {}
