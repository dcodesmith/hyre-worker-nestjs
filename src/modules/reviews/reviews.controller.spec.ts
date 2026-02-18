import { Reflector } from "@nestjs/core";
import { Test, TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { createReview } from "../../shared/helper.fixtures";
import { AuthService } from "../auth/auth.service";
import type { AuthSession } from "../auth/guards/session.guard";
import {
  createReviewSchema,
  reviewIdParamSchema,
  reviewQuerySchema,
  updateReviewSchema,
} from "./dto/reviews.dto";
import { ReviewsController } from "./reviews.controller";
import { ReviewsModerationService } from "./reviews-moderation.service";
import { ReviewsReadService } from "./reviews-read.service";
import { ReviewsWriteService } from "./reviews-write.service";

describe("ReviewsController", () => {
  let controller: ReviewsController;
  let reviewsWriteService: ReviewsWriteService;
  let reviewsReadService: ReviewsReadService;
  let reviewsModerationService: ReviewsModerationService;

  const mockUser: AuthSession["user"] = {
    id: "user-1",
    name: "Test User",
    emailVerified: false,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
    roles: ["user" as const],
  };
  const mockCreatedReview = createReview({ id: "review-1" });
  const mockUpdatedReview = createReview({ id: "review-1", overallRating: 4 });
  const mockHiddenReview = createReview({ id: "review-1", isVisible: false });
  const mockAdminUser: AuthSession["user"] = {
    id: "admin-1",
    name: "Admin User",
    emailVerified: false,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
    roles: ["admin"],
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ReviewsController],
      providers: [
        {
          provide: ReviewsWriteService,
          useValue: {
            createReview: vi.fn(),
            updateReview: vi.fn(),
          },
        },
        {
          provide: ReviewsReadService,
          useValue: {
            getReviewById: vi.fn(),
            getReviewByBookingId: vi.fn(),
            getCarReviews: vi.fn(),
            getChauffeurReviews: vi.fn(),
          },
        },
        {
          provide: ReviewsModerationService,
          useValue: {
            hideReview: vi.fn(),
          },
        },
        {
          provide: AuthService,
          useValue: {
            isInitialized: true,
            auth: {
              api: {
                getSession: vi.fn().mockResolvedValue(null),
              },
            },
            getUserRoles: vi.fn().mockResolvedValue(["user"]),
          },
        },
        Reflector,
      ],
    }).compile();

    controller = module.get<ReviewsController>(ReviewsController);
    reviewsWriteService = module.get<ReviewsWriteService>(ReviewsWriteService);
    reviewsReadService = module.get<ReviewsReadService>(ReviewsReadService);
    reviewsModerationService = module.get<ReviewsModerationService>(ReviewsModerationService);
  });

  it("creates review and returns created review", async () => {
    vi.mocked(reviewsWriteService.createReview).mockResolvedValueOnce(mockCreatedReview);

    const body = new ZodValidationPipe(createReviewSchema).transform({
      bookingId: "c123456789012345678901234",
      overallRating: 5,
      carRating: 4,
      chauffeurRating: 5,
      serviceRating: 4,
      comment: "Great",
    });

    const result = await controller.createReview(body, mockUser);

    expect(result).toEqual(mockCreatedReview);
  });

  it("updates review and returns updated review", async () => {
    vi.mocked(reviewsWriteService.updateReview).mockResolvedValueOnce(mockUpdatedReview);

    const reviewId = new ZodValidationPipe(reviewIdParamSchema).transform(
      "c123456789012345678901234",
    );
    const body = new ZodValidationPipe(updateReviewSchema).transform({
      overallRating: 4,
    });

    const result = await controller.updateReview(reviewId, body, mockUser);

    expect(result).toEqual(mockUpdatedReview);
  });

  it("returns paginated car reviews", async () => {
    vi.mocked(reviewsReadService.getCarReviews).mockResolvedValueOnce({
      reviews: [],
      pagination: {
        page: 1,
        limit: 10,
        total: 0,
        totalPages: 0,
        hasNextPage: false,
        hasPreviousPage: false,
      },
      ratings: {
        averageRating: 0,
        totalReviews: 0,
        ratingDistribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      },
    });

    const result = await controller.getCarReviews(
      "c123456789012345678901234",
      new ZodValidationPipe(reviewQuerySchema).transform({}),
    );

    expect(result).toHaveProperty("reviews");
    expect(result).toHaveProperty("pagination");
  });

  it("hides review and returns updated review", async () => {
    vi.mocked(reviewsModerationService.hideReview).mockResolvedValueOnce(mockHiddenReview);

    const result = await controller.hideReview(
      "c123456789012345678901234",
      { moderationNotes: "Spam" },
      mockAdminUser,
    );

    expect(result).toEqual(mockHiddenReview);
  });
});
