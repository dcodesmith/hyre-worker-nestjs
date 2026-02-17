import { Injectable, Logger } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { ReviewNotFoundException } from "./reviews.error";

@Injectable()
export class ReviewsModerationService {
  private readonly logger = new Logger(ReviewsModerationService.name);

  constructor(private readonly databaseService: DatabaseService) {}

  async hideReview(reviewId: string, moderatorId: string, moderationNotes?: string) {
    const review = await this.databaseService.review.findUnique({
      where: { id: reviewId },
      select: {
        id: true,
        isVisible: true,
      },
    });

    if (!review) {
      throw new ReviewNotFoundException();
    }

    if (!review.isVisible) {
      return this.databaseService.review.findUnique({
        where: { id: reviewId },
      });
    }

    const updatedReview = await this.databaseService.review.update({
      where: { id: reviewId },
      data: {
        isVisible: false,
        moderatedAt: new Date(),
        moderatedBy: moderatorId,
        moderationNotes: moderationNotes || "Review hidden by moderator",
      },
    });

    this.logger.log("Review hidden successfully", {
      reviewId,
      moderatorId,
    });

    return updatedReview;
  }
}
