import { Test, TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReview } from "../../shared/helper.fixtures";
import { DatabaseService } from "../database/database.service";
import { ReviewsReadService } from "./reviews-read.service";

type ReviewFindFirstCallArg = {
  where: Record<string, unknown>;
  select?: {
    booking?: {
      select?: {
        car?: { select?: Record<string, boolean> };
        chauffeur?: { select?: Record<string, boolean> };
      };
    };
  };
};

type ReviewFindManyCallArg = {
  where: {
    isVisible: true;
    booking: {
      carId?: string;
      chauffeurId?: string;
    };
  };
};

describe("ReviewsReadService", () => {
  let service: ReviewsReadService;
  let databaseService: DatabaseService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewsReadService,
        {
          provide: DatabaseService,
          useValue: {
            review: {
              findFirst: vi.fn(),
              findMany: vi.fn(),
              count: vi.fn(),
            },
          },
        },
      ],
    }).compile();

    service = module.get<ReviewsReadService>(ReviewsReadService);
    databaseService = module.get<DatabaseService>(DatabaseService);
  });

  it("returns car reviews with pagination", async () => {
    vi.mocked(databaseService.review.findMany)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([createReview({ carRating: 5 }), createReview({ carRating: 4 })]);
    vi.mocked(databaseService.review.count).mockResolvedValueOnce(0);

    const result = await service.getCarReviews("car-1", {
      page: 1,
      limit: 10,
      includeRatings: true,
    });

    expect(result.pagination.page).toBe(1);
    expect(result).toHaveProperty("ratings");
    expect(databaseService.review.findMany).toHaveBeenCalledTimes(2);
    const listQueryArgs = vi.mocked(databaseService.review.findMany).mock.calls[0]?.[0] as
      | ReviewFindManyCallArg
      | undefined;
    expect(listQueryArgs?.where.booking.carId).toBe("car-1");
    expect(listQueryArgs?.where.booking.chauffeurId).toBeUndefined();
  });

  it("uses restricted select shape for review-by-id details", async () => {
    vi.mocked(databaseService.review.findFirst).mockResolvedValueOnce(null);

    await service.getReviewById("review-1");

    expect(databaseService.review.findFirst).toHaveBeenCalledTimes(1);
    const firstCallArgs = vi.mocked(databaseService.review.findFirst).mock.calls[0]?.[0] as
      | ReviewFindFirstCallArg
      | undefined;

    expect(firstCallArgs?.where).toEqual({ id: "review-1", isVisible: true });
    expect(firstCallArgs?.select).toBeDefined();
    expect(firstCallArgs?.select?.booking?.select?.car?.select).toEqual({
      id: true,
      make: true,
      model: true,
      year: true,
      color: true,
    });
    expect(firstCallArgs?.select?.booking?.select?.chauffeur?.select).toEqual({
      id: true,
      name: true,
      image: true,
    });
    expect(firstCallArgs?.select?.booking?.select?.chauffeur?.select?.email).toBeUndefined();
    expect(firstCallArgs?.select?.booking?.select?.car?.select?.registrationNumber).toBeUndefined();
  });

  it("uses restricted select shape for review-by-booking details", async () => {
    vi.mocked(databaseService.review.findFirst).mockResolvedValueOnce(null);

    await service.getReviewByBookingId("booking-1");

    expect(databaseService.review.findFirst).toHaveBeenCalledTimes(1);
    const firstCallArgs = vi.mocked(databaseService.review.findFirst).mock.calls[0]?.[0] as
      | ReviewFindFirstCallArg
      | undefined;

    expect(firstCallArgs?.where).toEqual({ bookingId: "booking-1", isVisible: true });
    expect(firstCallArgs?.select).toBeDefined();
    expect(firstCallArgs?.select?.booking?.select?.car?.select).toEqual({
      id: true,
      make: true,
      model: true,
      year: true,
      color: true,
    });
    expect(firstCallArgs?.select?.booking?.select?.chauffeur?.select).toEqual({
      id: true,
      name: true,
      image: true,
    });
    expect(firstCallArgs?.select?.booking?.select?.chauffeur?.select?.phoneNumber).toBeUndefined();
    expect(firstCallArgs?.select?.booking?.select?.car?.select?.approvalNotes).toBeUndefined();
  });

  it("returns chauffeur reviews with pagination", async () => {
    vi.mocked(databaseService.review.findMany).mockResolvedValueOnce([]);
    vi.mocked(databaseService.review.count).mockResolvedValueOnce(0);

    const result = await service.getChauffeurReviews("chauffeur-1", {
      page: 1,
      limit: 10,
      includeRatings: false,
    });

    expect(result.pagination.limit).toBe(10);
    expect(result).not.toHaveProperty("ratings");
    expect(databaseService.review.findMany).toHaveBeenCalledTimes(1);
    const listQueryArgs = vi.mocked(databaseService.review.findMany).mock.calls[0]?.[0] as
      | ReviewFindManyCallArg
      | undefined;
    expect(listQueryArgs?.where.booking.chauffeurId).toBe("chauffeur-1");
    expect(listQueryArgs?.where.booking.carId).toBeUndefined();
  });
});
