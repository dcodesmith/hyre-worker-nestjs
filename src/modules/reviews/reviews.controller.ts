import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
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
    @Body(new ZodValidationPipe(createReviewSchema)) body: CreateReviewDto,
    @CurrentUser() user: AuthSession["user"],
  ) {
    return this.reviewsWriteService.createReview(user.id, body);
  }

  @Get("car/:carId")
  async getCarReviews(
    @Param("carId", new ZodValidationPipe(carIdParamSchema)) carId: string,
    @Query(new ZodValidationPipe(reviewQuerySchema)) query: ReviewQueryDto,
  ) {
    return this.reviewsReadService.getCarReviews(carId, query);
  }

  @Get("chauffeur/:chauffeurId")
  async getChauffeurReviews(
    @Param("chauffeurId", new ZodValidationPipe(chauffeurIdParamSchema)) chauffeurId: string,
    @Query(new ZodValidationPipe(reviewQuerySchema)) query: ReviewQueryDto,
  ) {
    return this.reviewsReadService.getChauffeurReviews(chauffeurId, query);
  }

  @Get("booking/:bookingId")
  async getReviewByBooking(
    @Param("bookingId", new ZodValidationPipe(bookingIdParamSchema)) bookingId: string,
  ) {
    return this.reviewsReadService.getReviewByBookingId(bookingId);
  }

  @Get(":reviewId")
  async getReviewById(
    @Param("reviewId", new ZodValidationPipe(reviewIdParamSchema)) reviewId: string,
  ) {
    return this.reviewsReadService.getReviewById(reviewId);
  }

  @Put(":reviewId")
  @UseGuards(SessionGuard)
  async updateReview(
    @Param("reviewId", new ZodValidationPipe(reviewIdParamSchema)) reviewId: string,
    @Body(new ZodValidationPipe(updateReviewSchema)) body: UpdateReviewDto,
    @CurrentUser() user: AuthSession["user"],
  ) {
    return this.reviewsWriteService.updateReview(user.id, reviewId, body);
  }

  @Delete(":reviewId")
  @UseGuards(SessionGuard, RoleGuard)
  @Roles(ADMIN)
  async hideReview(
    @Param("reviewId", new ZodValidationPipe(reviewIdParamSchema)) reviewId: string,
    @Body(new ZodValidationPipe(hideReviewSchema)) body: HideReviewDto,
    @CurrentUser() user: AuthSession["user"],
  ) {
    return this.reviewsModerationService.hideReview(reviewId, user.id, body.moderationNotes);
  }
}
