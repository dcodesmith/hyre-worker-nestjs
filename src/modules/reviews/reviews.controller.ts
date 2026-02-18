import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import { ZodBody, ZodParam, ZodQuery } from "../../common/decorators/zod-validation.decorator";
import { ADMIN } from "../auth/auth.types";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { Roles } from "../auth/decorators/roles.decorator";
import { RoleGuard } from "../auth/guards/role.guard";
import type { AuthSession } from "../auth/guards/session.guard";
import { SessionGuard } from "../auth/guards/session.guard";
import {
  bookingIdParamSchema,
  type CreateReviewDto,
  carIdParamSchema,
  chauffeurIdParamSchema,
  createReviewSchema,
  type HideReviewDto,
  hideReviewSchema,
  type ReviewQueryDto,
  reviewIdParamSchema,
  reviewQuerySchema,
  type UpdateReviewDto,
  updateReviewSchema,
} from "./dto/reviews.dto";
import { ReviewsModerationService } from "./reviews-moderation.service";
import { ReviewsReadService } from "./reviews-read.service";
import { ReviewsWriteService } from "./reviews-write.service";

@Controller("api/reviews")
export class ReviewsController {
  constructor(
    private readonly reviewsWriteService: ReviewsWriteService,
    private readonly reviewsReadService: ReviewsReadService,
    private readonly reviewsModerationService: ReviewsModerationService,
  ) {}

  @Post("create")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(SessionGuard)
  async createReview(
    @ZodBody(createReviewSchema) body: CreateReviewDto,
    @CurrentUser() user: AuthSession["user"],
  ) {
    return this.reviewsWriteService.createReview(user.id, body);
  }

  @Get("car/:carId")
  async getCarReviews(
    @ZodParam("carId", carIdParamSchema) carId: string,
    @ZodQuery(reviewQuerySchema) query: ReviewQueryDto,
  ) {
    return this.reviewsReadService.getCarReviews(carId, query);
  }

  @Get("chauffeur/:chauffeurId")
  async getChauffeurReviews(
    @ZodParam("chauffeurId", chauffeurIdParamSchema) chauffeurId: string,
    @ZodQuery(reviewQuerySchema) query: ReviewQueryDto,
  ) {
    return this.reviewsReadService.getChauffeurReviews(chauffeurId, query);
  }

  @Get("booking/:bookingId")
  async getReviewByBooking(@ZodParam("bookingId", bookingIdParamSchema) bookingId: string) {
    return this.reviewsReadService.getReviewByBookingId(bookingId);
  }

  @Get(":reviewId")
  async getReviewById(@ZodParam("reviewId", reviewIdParamSchema) reviewId: string) {
    return this.reviewsReadService.getReviewById(reviewId);
  }

  @Put(":reviewId")
  @UseGuards(SessionGuard)
  async updateReview(
    @ZodParam("reviewId", reviewIdParamSchema) reviewId: string,
    @ZodBody(updateReviewSchema) body: UpdateReviewDto,
    @CurrentUser() user: AuthSession["user"],
  ) {
    return this.reviewsWriteService.updateReview(user.id, reviewId, body);
  }

  @Delete(":reviewId")
  @UseGuards(SessionGuard, RoleGuard)
  @Roles(ADMIN)
  async hideReview(
    @ZodParam("reviewId", reviewIdParamSchema) reviewId: string,
    @ZodBody(hideReviewSchema) body: HideReviewDto,
    @CurrentUser() user: AuthSession["user"],
  ) {
    return this.reviewsModerationService.hideReview(reviewId, user.id, body.moderationNotes);
  }
}
