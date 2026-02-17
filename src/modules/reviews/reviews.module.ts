import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { NotificationModule } from "../notification/notification.module";
import { ReviewsController } from "./reviews.controller";
import { ReviewsModerationService } from "./reviews-moderation.service";
import { ReviewsReadService } from "./reviews-read.service";
import { ReviewsWriteService } from "./reviews-write.service";

@Module({
  imports: [AuthModule, NotificationModule],
  controllers: [ReviewsController],
  providers: [ReviewsWriteService, ReviewsReadService, ReviewsModerationService],
  exports: [ReviewsWriteService, ReviewsReadService, ReviewsModerationService],
})
export class ReviewsModule {}
