import { HttpStatus, type INestApplication } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { GlobalExceptionFilter } from "../src/common/filters/global-exception.filter";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import { DatabaseService } from "../src/modules/database/database.service";
import { NotificationService } from "../src/modules/notification/notification.service";
import { TestDataFactory, uniqueEmail } from "./helpers";

describe("Reviews E2E Tests", () => {
  let app: INestApplication;
  let databaseService: DatabaseService;
  let factory: TestDataFactory;

  let userCookie: string;
  let userId: string;
  let otherUserCookie: string;
  let adminCookie: string;
  let adminUserId: string;

  beforeAll(async () => {
    const mockSendOTPEmail = vi.fn().mockResolvedValue(undefined);
    const mockQueueReviewReceivedNotifications = vi.fn().mockResolvedValue(undefined);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuthEmailService)
      .useValue({ sendOTPEmail: mockSendOTPEmail })
      .overrideProvider(NotificationService)
      .useValue({ queueReviewReceivedNotifications: mockQueueReviewReceivedNotifications })
      .compile();

    app = moduleFixture.createNestApplication({
      logger: false,
    });

    const httpAdapterHost = app.get(HttpAdapterHost);
    app.useGlobalFilters(new GlobalExceptionFilter(httpAdapterHost));

    databaseService = app.get(DatabaseService);
    factory = new TestDataFactory(databaseService, app);

    await app.init();

    const userEmail = uniqueEmail("reviews-user");
    const userAuth = await factory.authenticateAndGetUser(userEmail, "user");
    userCookie = userAuth.cookie;
    userId = userAuth.user.id;

    const otherEmail = uniqueEmail("reviews-other-user");
    otherUserCookie = await factory.authenticateAndGetCookie(otherEmail, "user");

    const adminEmail = uniqueEmail("reviews-admin");
    const adminAuth = await factory.createAuthenticatedAdmin(adminEmail);
    adminCookie = adminAuth.cookie;
    adminUserId = adminAuth.user.id;
  });

  beforeEach(async () => {
    await factory.clearRateLimits();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("POST /api/reviews/create", () => {
    it("should create a review for completed booking with chauffeur", async () => {
      const booking = await factory.createCompletedBookingWithChauffeur(userId);

      const response = await request(app.getHttpServer())
        .post("/api/reviews/create")
        .set("Cookie", userCookie)
        .send({
          bookingId: booking.id,
          overallRating: 5,
          carRating: 5,
          chauffeurRating: 4,
          serviceRating: 5,
          comment: "Excellent trip",
        });

      expect(response.status).toBe(HttpStatus.CREATED);
      expect(response.body.bookingId).toBe(booking.id);
      expect(response.body.userId).toBe(userId);
      expect(response.body.overallRating).toBe(5);
      expect(response.body.comment).toBe("Excellent trip");
    });

    it("should reject duplicate review for same booking", async () => {
      const booking = await factory.createCompletedBookingWithChauffeur(userId);
      await factory.createReview(booking.id, userId);

      const response = await request(app.getHttpServer())
        .post("/api/reviews/create")
        .set("Cookie", userCookie)
        .send({
          bookingId: booking.id,
          overallRating: 4,
          carRating: 4,
          chauffeurRating: 4,
          serviceRating: 4,
        });

      expect(response.status).toBe(HttpStatus.CONFLICT);
      expect(response.body.message).toContain("already exists");
    });

    it("should require authentication", async () => {
      const booking = await factory.createCompletedBookingWithChauffeur(userId);

      const response = await request(app.getHttpServer()).post("/api/reviews/create").send({
        bookingId: booking.id,
        overallRating: 5,
        carRating: 5,
        chauffeurRating: 5,
        serviceRating: 5,
      });

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    });
  });

  describe("GET /api/reviews endpoints", () => {
    it("should return review by id and by booking id", async () => {
      const booking = await factory.createCompletedBookingWithChauffeur(userId);
      const review = await factory.createReview(booking.id, userId, {
        overallRating: 4,
        comment: "Solid service",
      });

      const byIdResponse = await request(app.getHttpServer()).get(`/api/reviews/${review.id}`);
      expect(byIdResponse.status).toBe(HttpStatus.OK);
      expect(byIdResponse.body.id).toBe(review.id);

      const byBookingResponse = await request(app.getHttpServer()).get(
        `/api/reviews/booking/${booking.id}`,
      );
      expect(byBookingResponse.status).toBe(HttpStatus.OK);
      expect(byBookingResponse.body.bookingId).toBe(booking.id);
    });

    it("should list car reviews with ratings aggregate", async () => {
      const booking1 = await factory.createCompletedBookingWithChauffeur(userId);
      const booking2 = await factory.createBooking(userId, booking1.carId, {
        status: "COMPLETED",
        chauffeurId: booking1.chauffeurId,
      });

      await factory.createReview(booking1.id, userId, { carRating: 5, overallRating: 5 });
      await factory.createReview(booking2.id, userId, { carRating: 3, overallRating: 3 });

      const response = await request(app.getHttpServer()).get(
        `/api/reviews/car/${booking1.carId}?page=1&limit=10&includeRatings=true`,
      );

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body.reviews).toHaveLength(2);
      expect(response.body.ratings.totalReviews).toBe(2);
      expect(response.body.ratings.averageRating).toBe(4);
      expect(response.body.ratings.ratingDistribution["5"]).toBe(1);
      expect(response.body.ratings.ratingDistribution["3"]).toBe(1);
    });
  });

  describe("PUT /api/reviews/:reviewId", () => {
    it("should update own review", async () => {
      const booking = await factory.createCompletedBookingWithChauffeur(userId);
      const review = await factory.createReview(booking.id, userId, {
        comment: "Initial comment",
        overallRating: 3,
      });

      const response = await request(app.getHttpServer())
        .put(`/api/reviews/${review.id}`)
        .set("Cookie", userCookie)
        .send({
          comment: "Updated comment",
          overallRating: 5,
        });

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body.comment).toBe("Updated comment");
      expect(response.body.overallRating).toBe(5);
    });

    it("should reject updating another user's review", async () => {
      const booking = await factory.createCompletedBookingWithChauffeur(userId);
      const review = await factory.createReview(booking.id, userId);

      const response = await request(app.getHttpServer())
        .put(`/api/reviews/${review.id}`)
        .set("Cookie", otherUserCookie)
        .send({ comment: "Should not work" });

      expect(response.status).toBe(HttpStatus.FORBIDDEN);
      expect(response.body.message).toContain("own reviews");
    });
  });

  describe("DELETE /api/reviews/:reviewId", () => {
    it("should reject non-admin user", async () => {
      const booking = await factory.createCompletedBookingWithChauffeur(userId);
      const review = await factory.createReview(booking.id, userId);

      const response = await request(app.getHttpServer())
        .delete(`/api/reviews/${review.id}`)
        .set("Cookie", userCookie)
        .send({ moderationNotes: "Not allowed" });

      expect(response.status).toBe(HttpStatus.FORBIDDEN);
    });

    it("should hide review for admin", async () => {
      const booking = await factory.createCompletedBookingWithChauffeur(userId);
      const review = await factory.createReview(booking.id, userId, { isVisible: true });

      const response = await request(app.getHttpServer())
        .delete(`/api/reviews/${review.id}`)
        .set("Cookie", adminCookie)
        .send({ moderationNotes: "Policy violation" });

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body.isVisible).toBe(false);
      expect(response.body.moderatedBy).toBe(adminUserId);

      const storedReview = await factory.getReviewById(review.id);
      expect(storedReview?.isVisible).toBe(false);
      expect(storedReview?.moderationNotes).toBe("Policy violation");

      const getResponse = await request(app.getHttpServer()).get(`/api/reviews/${review.id}`);
      expect(getResponse.status).toBe(HttpStatus.OK);
      expect(getResponse.body).toEqual({});
    });
  });
});
