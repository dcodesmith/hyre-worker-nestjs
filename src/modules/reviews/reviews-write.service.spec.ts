import { Test, TestingModule } from "@nestjs/testing";
import { BookingStatus, Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBooking, createReview } from "../../shared/helper.fixtures";
import { DatabaseService } from "../database/database.service";
import { NotificationService } from "../notification/notification.service";
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
  let notificationService: NotificationService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewsWriteService,
        {
          provide: DatabaseService,
          useValue: {
            booking: {
              findFirst: vi.fn(),
            },
            review: {
              create: vi.fn(),
              findUnique: vi.fn(),
              update: vi.fn(),
            },
          },
        },
        {
          provide: NotificationService,
          useValue: {
            queueReviewReceivedNotifications: vi.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get<ReviewsWriteService>(ReviewsWriteService);
    databaseService = module.get<DatabaseService>(DatabaseService);
    notificationService = module.get<NotificationService>(NotificationService);
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

    it("creates review for eligible booking", async () => {
      vi.mocked(databaseService.booking.findFirst).mockResolvedValueOnce({
        id: input.bookingId,
        userId: "user-1",
        status: BookingStatus.COMPLETED,
        endDate: new Date(),
        chauffeurId: "chauffeur-1",
        bookingReference: "BK-12345678",
        car: {
          make: "Toyota",
          model: "Camry",
          year: 2023,
          owner: {
            id: "owner-1",
            name: "Fleet Owner",
            email: "owner@example.com",
          },
        },
        chauffeur: {
          id: "chauffeur-1",
          name: "Driver",
          email: "driver@example.com",
        },
        user: {
          name: "Customer",
          email: "customer@example.com",
        },
        deletedAt: null,
      } as never);

      vi.mocked(databaseService.review.create).mockResolvedValueOnce(
        createReview({
          id: "review-1",
          bookingId: input.bookingId,
          userId: "user-1",
        }),
      );

      const result = await service.createReview("user-1", input);

      expect(result).toEqual(
        createReview({
          id: "review-1",
          bookingId: input.bookingId,
          userId: "user-1",
        }),
      );
      expect(databaseService.review.create).toHaveBeenCalled();
      // Non-blocking notification dispatch should still enqueue notifications
      await Promise.resolve();
      expect(notificationService.queueReviewReceivedNotifications).toHaveBeenCalledTimes(1);
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
      vi.mocked(databaseService.booking.findFirst).mockResolvedValueOnce({
        id: input.bookingId,
        userId: "user-1",
        status: BookingStatus.COMPLETED,
        endDate: new Date(),
        chauffeurId: "chauffeur-1",
        bookingReference: "BK-12345678",
        car: {
          make: "Toyota",
          model: "Camry",
          year: 2023,
          owner: {
            id: "owner-1",
            name: "Fleet Owner",
            email: "owner@example.com",
          },
        },
        chauffeur: {
          id: "chauffeur-1",
          name: "Driver",
          email: "driver@example.com",
        },
        user: {
          name: "Customer",
          email: "customer@example.com",
        },
        deletedAt: null,
      } as never);

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

    it("does not fail review creation when notification queueing fails", async () => {
      vi.mocked(databaseService.booking.findFirst).mockResolvedValueOnce({
        id: input.bookingId,
        userId: "user-1",
        status: BookingStatus.COMPLETED,
        endDate: new Date(),
        chauffeurId: "chauffeur-1",
        bookingReference: "BK-12345678",
        car: {
          make: "Toyota",
          model: "Camry",
          year: 2023,
          owner: {
            id: "owner-1",
            name: "Fleet Owner",
            email: "owner@example.com",
          },
        },
        chauffeur: {
          id: "chauffeur-1",
          name: "Driver",
          email: "driver@example.com",
        },
        user: {
          name: "Customer",
          email: "customer@example.com",
        },
        deletedAt: null,
      } as never);

      vi.mocked(databaseService.review.create).mockResolvedValueOnce(
        createReview({
          id: "review-2",
          bookingId: input.bookingId,
          userId: "user-1",
        }),
      );

      vi.mocked(notificationService.queueReviewReceivedNotifications).mockRejectedValueOnce(
        new Error("Queue unavailable"),
      );

      await expect(service.createReview("user-1", input)).resolves.toEqual(
        createReview({
          id: "review-2",
          bookingId: input.bookingId,
          userId: "user-1",
        }),
      );
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
  });
});
