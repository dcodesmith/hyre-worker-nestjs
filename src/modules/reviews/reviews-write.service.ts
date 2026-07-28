import { Injectable } from "@nestjs/common";
import { BookingStatus, Prisma } from "@prisma/client";
import { subDays } from "date-fns";
import { DatabaseService } from "../database/database.service";
import { ReviewReceivedHandler } from "../notification/handlers/review-received.handler";
import { NotificationOutboxService } from "../notification/notification-outbox.service";
import type { CreateReviewDto, UpdateReviewDto } from "./dto/reviews.dto";
import {
  ReviewAlreadyExistsException,
  ReviewBookingChauffeurRequiredException,
  ReviewBookingNotCompletedException,
  ReviewBookingNotFoundException,
  ReviewCreationWindowExpiredException,
  ReviewNotFoundException,
  ReviewOwnershipRequiredException,
  ReviewUpdateWindowExpiredException,
} from "./reviews.error";

@Injectable()
export class ReviewsWriteService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly notificationOutboxService: NotificationOutboxService,
    private readonly reviewReceivedHandler: ReviewReceivedHandler,
  ) {}

  async createReview(userId: string, input: CreateReviewDto) {
    const booking = await this.databaseService.booking.findFirst({
      where: { id: input.bookingId, deletedAt: null },
      select: {
        id: true,
        userId: true,
        status: true,
        endDate: true,
        chauffeurId: true,
        bookingReference: true,
        car: {
          select: {
            make: true,
            model: true,
            year: true,
            owner: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
        },
        chauffeur: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        user: {
          select: {
            name: true,
            email: true,
          },
        },
      },
    });

    if (!booking) {
      throw new ReviewBookingNotFoundException();
    }

    if (booking.status !== BookingStatus.COMPLETED) {
      throw new ReviewBookingNotCompletedException();
    }

    if (booking.userId !== userId) {
      throw new ReviewOwnershipRequiredException("You can only review your own bookings");
    }

    if (!booking.chauffeurId) {
      throw new ReviewBookingChauffeurRequiredException();
    }

    if (!booking.chauffeur) {
      throw new ReviewBookingChauffeurRequiredException();
    }
    const chauffeur = booking.chauffeur;

    const thirtyDaysAgo = subDays(new Date(), 30);
    if (booking.endDate < thirtyDaysAgo) {
      throw new ReviewCreationWindowExpiredException();
    }

    try {
      return await this.databaseService.$transaction(async (tx) => {
        const review = await tx.review.create({
          data: {
            bookingId: input.bookingId,
            userId,
            overallRating: input.overallRating,
            carRating: input.carRating,
            chauffeurRating: input.chauffeurRating,
            serviceRating: input.serviceRating,
            comment: input.comment ?? null,
            isVisible: true,
          },
        });

        await this.notificationOutboxService.create(
          this.reviewReceivedHandler,
          {
            reviewId: review.id,
            bookingId: booking.id,
            owner: {
              userId: booking.car.owner.id,
              name: booking.car.owner.name || "Fleet Owner",
              email: booking.car.owner.email,
            },
            chauffeur: {
              userId: chauffeur.id,
              name: chauffeur.name || "Chauffeur",
              email: chauffeur.email,
            },
            review: {
              customerName: booking.user?.name || booking.user?.email || "Customer",
              bookingReference: booking.bookingReference,
              carName: booking.car.year
                ? `${booking.car.make} ${booking.car.model} (${booking.car.year})`
                : `${booking.car.make} ${booking.car.model}`,
              overallRating: input.overallRating,
              carRating: input.carRating,
              chauffeurRating: input.chauffeurRating,
              serviceRating: input.serviceRating,
              comment: input.comment ?? null,
              reviewDate: review.createdAt,
            },
          },
          tx,
        );

        return review;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ReviewAlreadyExistsException();
      }
      throw error;
    }
  }

  async updateReview(userId: string, reviewId: string, input: UpdateReviewDto) {
    const existingReview = await this.databaseService.review.findUnique({
      where: { id: reviewId },
      select: {
        id: true,
        bookingId: true,
        userId: true,
        isVisible: true,
        createdAt: true,
      },
    });

    if (!existingReview) {
      throw new ReviewNotFoundException();
    }

    if (!existingReview.isVisible) {
      throw new ReviewNotFoundException();
    }

    if (existingReview.userId !== userId) {
      throw new ReviewOwnershipRequiredException("You can only update your own reviews");
    }

    const sevenDaysAgo = subDays(new Date(), 7);
    if (existingReview.createdAt < sevenDaysAgo) {
      throw new ReviewUpdateWindowExpiredException();
    }

    return this.databaseService.review.update({
      where: { id: reviewId },
      data: {
        ...(input.overallRating !== undefined && { overallRating: input.overallRating }),
        ...(input.carRating !== undefined && { carRating: input.carRating }),
        ...(input.chauffeurRating !== undefined && { chauffeurRating: input.chauffeurRating }),
        ...(input.serviceRating !== undefined && { serviceRating: input.serviceRating }),
        ...(input.comment !== undefined && { comment: input.comment }),
      },
    });
  }
}
