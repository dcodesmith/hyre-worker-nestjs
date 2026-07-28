import { Test, TestingModule } from "@nestjs/testing";
import { BookingStatus, Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBooking,
  createCar,
  createChauffeur,
  createOwner,
  createReview,
  createUser,
} from "../../shared/helper.fixtures";
import { DatabaseService } from "../database/database.service";
import { ReviewReceivedHandler } from "../notification/handlers/review-received.handler";
import { NotificationOutboxService } from "../notification/notification-outbox.service";
import {
  ReviewAlreadyExistsException,
  ReviewBookingNotCompletedException,
  ReviewBookingNotFoundException,
  ReviewNotFoundException,
  ReviewOwnershipRequiredException,
} from "./reviews.error";
import { ReviewsWriteService } from "./reviews-write.service";

describe("ReviewsWriteService", () => {
  let service: ReviewsWriteService;
  let databaseService: DatabaseService;
  let notificationOutboxService: NotificationOutboxService;
  let reviewReceivedHandler: ReviewReceivedHandler;
  let transactionClient: {
    review: {
      create: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    const reviewCreate = vi.fn();
    transactionClient = {
      review: {
        create: reviewCreate,
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewsWriteService,
        {
          provide: DatabaseService,
          useValue: {
            $transaction: vi.fn((callback: (tx: typeof transactionClient) => Promise<unknown>) =>
              callback(transactionClient),
            ),
            booking: {
              findFirst: vi.fn(),
            },
            review: {
              create: reviewCreate,
              findUnique: vi.fn(),
              update: vi.fn(),
            },
          },
        },
        {
          provide: NotificationOutboxService,
          useValue: {
            create: vi.fn().mockResolvedValue(2),
          },
        },
        {
          provide: ReviewReceivedHandler,
          useValue: {},
        },
      ],
    }).compile();

    service = module.get<ReviewsWriteService>(ReviewsWriteService);
    databaseService = module.get<DatabaseService>(DatabaseService);
    notificationOutboxService = module.get<NotificationOutboxService>(NotificationOutboxService);
    reviewReceivedHandler = module.get<ReviewReceivedHandler>(ReviewReceivedHandler);
  });

  describe("createReview", () => {
    const input = {
      bookingId: "c123456789012345678901234",
      overallRating: 5,
      carRating: 5,
      chauffeurRating: 5,
      serviceRating: 5,
      comment: "Great service",
    };
    const createReviewBookingMock = (
      overrides: Partial<{
        id: string;
        userId: string;
        status: BookingStatus;
        endDate: Date;
        chauffeurId: string | null;
        bookingReference: string;
      }> = {},
    ) => {
      const car = createCar({
        make: "Toyota",
        model: "Camry",
        year: 2023,
        owner: createOwner({ id: "owner-1" }),
      });
      const chauffeur = createChauffeur({
        id: "chauffeur-1",
        name: "Driver",
        email: "driver@example.com",
      });
      const user = createUser({
        name: "Customer",
        email: "customer@example.com",
      });

      return createBooking({
        id: input.bookingId,
        userId: "user-1",
        status: BookingStatus.COMPLETED,
        endDate: new Date(),
        chauffeurId: "chauffeur-1",
        bookingReference: "BK-12345678",
        car,
        chauffeur,
        user,
        deletedAt: null,
        ...overrides,
      });
    };

    it("creates review for eligible booking", async () => {
      vi.mocked(databaseService.booking.findFirst).mockResolvedValueOnce(createReviewBookingMock());
      const createdReview = createReview({
        id: "review-1",
        bookingId: input.bookingId,
        userId: "user-1",
        createdAt: new Date("2026-07-28T12:00:00.000Z"),
      });
      vi.mocked(databaseService.review.create).mockResolvedValueOnce(createdReview);

      const result = await service.createReview("user-1", input);

      expect(result).toEqual(createdReview);
      expect(databaseService.$transaction).toHaveBeenCalledOnce();
      expect(databaseService.review.create).toHaveBeenCalled();
      expect(notificationOutboxService.create).toHaveBeenCalledWith(
        reviewReceivedHandler,
        expect.objectContaining({
          reviewId: "review-1",
          bookingId: input.bookingId,
          owner: expect.objectContaining({ userId: "owner-1" }),
          chauffeur: expect.objectContaining({ userId: "chauffeur-1" }),
          review: expect.objectContaining({
            customerName: "Customer",
            bookingReference: "BK-12345678",
            reviewDate: createdReview.createdAt,
          }),
        }),
        transactionClient,
      );
    });

    it("throws when booking does not exist", async () => {
      vi.mocked(databaseService.booking.findFirst).mockResolvedValueOnce(null);

      await expect(service.createReview("user-1", input)).rejects.toThrow(
        ReviewBookingNotFoundException,
      );
    });

    it("throws when booking is not completed", async () => {
      vi.mocked(databaseService.booking.findFirst).mockResolvedValueOnce({
        ...createBooking({
          id: input.bookingId,
          userId: "user-1",
          status: BookingStatus.CONFIRMED,
          endDate: new Date(),
          chauffeurId: "chauffeur-1",
        }),
        deletedAt: null,
      });

      await expect(service.createReview("user-1", input)).rejects.toThrow(
        ReviewBookingNotCompletedException,
      );
    });

    it("throws when booking belongs to another user", async () => {
      vi.mocked(databaseService.booking.findFirst).mockResolvedValueOnce({
        ...createBooking({
          id: input.bookingId,
          userId: "user-2",
          status: BookingStatus.COMPLETED,
          endDate: new Date(),
          chauffeurId: "chauffeur-1",
        }),
        deletedAt: null,
      });

      await expect(service.createReview("user-1", input)).rejects.toThrow(
        ReviewOwnershipRequiredException,
      );
    });

    it("throws when review already exists", async () => {
      vi.mocked(databaseService.booking.findFirst).mockResolvedValueOnce(createReviewBookingMock());

      vi.mocked(databaseService.review.create).mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("Unique failed", {
          clientVersion: "5.x",
          code: "P2002",
          meta: { target: ["bookingId"] },
        }),
      );

      await expect(service.createReview("user-1", input)).rejects.toThrow(
        ReviewAlreadyExistsException,
      );
    });

    it("fails the transaction when the durable notification cannot be created", async () => {
      vi.mocked(databaseService.booking.findFirst).mockResolvedValueOnce(createReviewBookingMock());

      vi.mocked(databaseService.review.create).mockResolvedValueOnce(
        createReview({
          id: "review-2",
          bookingId: input.bookingId,
          userId: "user-1",
        }),
      );

      vi.mocked(notificationOutboxService.create).mockRejectedValueOnce(
        new Error("Queue unavailable"),
      );

      await expect(service.createReview("user-1", input)).rejects.toThrow("Queue unavailable");
    });
  });

  describe("updateReview", () => {
    it("updates own review within edit window", async () => {
      vi.mocked(databaseService.review.findUnique).mockResolvedValueOnce(
        createReview({
          id: "review-1",
          bookingId: "booking-1",
          userId: "user-1",
          createdAt: new Date(),
        }),
      );

      vi.mocked(databaseService.review.update).mockResolvedValueOnce({
        ...createReview({
          id: "review-1",
          overallRating: 4,
        }),
      });

      const result = await service.updateReview("user-1", "review-1", { overallRating: 4 });

      expect(result).toEqual(
        createReview({
          id: "review-1",
          overallRating: 4,
        }),
      );
    });

    it("throws when review is not found", async () => {
      vi.mocked(databaseService.review.findUnique).mockResolvedValueOnce(null);

      await expect(
        service.updateReview("user-1", "review-1", { overallRating: 4 }),
      ).rejects.toThrow(ReviewNotFoundException);
    });

    it("throws when user does not own the review", async () => {
      vi.mocked(databaseService.review.findUnique).mockResolvedValueOnce(
        createReview({
          id: "review-1",
          bookingId: "booking-1",
          userId: "user-2",
          createdAt: new Date(),
        }),
      );

      await expect(
        service.updateReview("user-1", "review-1", { overallRating: 4 }),
      ).rejects.toThrow(ReviewOwnershipRequiredException);
    });

    it("throws when review has been hidden by moderation", async () => {
      vi.mocked(databaseService.review.findUnique).mockResolvedValueOnce({
        ...createReview({
          id: "review-1",
          bookingId: "booking-1",
          userId: "user-1",
          createdAt: new Date(),
        }),
        isVisible: false,
      });

      await expect(
        service.updateReview("user-1", "review-1", { overallRating: 4 }),
      ).rejects.toThrow(ReviewNotFoundException);
      expect(databaseService.review.update).not.toHaveBeenCalled();
    });
  });
});
