import { HttpStatus, type INestApplication } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { GlobalExceptionFilter } from "../src/common/filters/global-exception.filter";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import { DatabaseService } from "../src/modules/database/database.service";
import { TestDataFactory, uniqueEmail } from "./helpers";

describe("Referrals E2E Tests", () => {
  let app: INestApplication;
  let databaseService: DatabaseService;
  let factory: TestDataFactory;
  let userCookie: string;
  let userId: string;

  beforeAll(async () => {
    const mockSendOtpEmail = vi.fn().mockResolvedValue(undefined);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuthEmailService)
      .useValue({ sendOTPEmail: mockSendOtpEmail })
      .compile();

    app = moduleFixture.createNestApplication({ logger: false });
    const httpAdapterHost = app.get(HttpAdapterHost);
    app.useGlobalFilters(new GlobalExceptionFilter(httpAdapterHost));

    databaseService = app.get(DatabaseService);
    factory = new TestDataFactory(databaseService, app);

    await app.init();

    const auth = await factory.authenticateAndGetUser(uniqueEmail("referral-user"), "user");
    userCookie = auth.cookie;
    userId = auth.user.id;
  });

  beforeEach(async () => {
    await factory.clearRateLimits();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("GET /api/referrals/validate/:code", () => {
    it("requires authentication", async () => {
      const response = await request(app.getHttpServer()).get("/api/referrals/validate/ABCD1234");

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it("returns 429 after exceeding validation attempts from same IP", async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await request(app.getHttpServer())
          .get("/api/referrals/validate/INVAL123")
          .set("Cookie", userCookie)
          .set("x-forwarded-for", "10.10.10.10");
      }

      const response = await request(app.getHttpServer())
        .get("/api/referrals/validate/INVAL123")
        .set("Cookie", userCookie)
        .set("x-forwarded-for", "10.10.10.10");

      expect(response.status).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect(response.body.detail).toBe("Too many validation attempts. Please try again later.");
      expect(response.headers["retry-after"]).toBeDefined();
      expect(response.headers["ratelimit-limit"]).toBe("20");
      expect(response.headers["ratelimit-remaining"]).toBe("0");
    });
  });

  describe("GET /api/referrals/eligibility", () => {
    it("requires authentication", async () => {
      const response = await request(app.getHttpServer()).get(
        "/api/referrals/eligibility?amount=50000&type=DAY",
      );

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    });
  });

  describe("GET /api/referrals/user", () => {
    it("returns referral user summary payload", async () => {
      await databaseService.user.update({
        where: { id: userId },
        data: {
          referralCode: "USRREF01",
          referralDiscountUsed: false,
          referralSignupAt: new Date("2030-01-01T00:00:00.000Z"),
        },
      });

      const referredUser = await factory.createUser();
      await databaseService.user.update({
        where: { id: referredUser.id },
        data: {
          referredByUserId: userId,
        },
      });

      const booking = await factory.createBookingWithDependencies(referredUser.id, {
        booking: { status: "COMPLETED", paymentStatus: "PAID" },
      });

      await databaseService.referralReward.create({
        data: {
          referrerUserId: userId,
          refereeUserId: referredUser.id,
          bookingId: booking.id,
          amount: 1200,
          status: "RELEASED",
          releaseCondition: "COMPLETED",
          processedAt: new Date(),
        },
      });

      await databaseService.userReferralStats.upsert({
        where: { userId },
        create: {
          userId,
          totalReferrals: 1,
          totalRewardsGranted: 1200,
          totalRewardsPending: 0,
        },
        update: {
          totalReferrals: 1,
          totalRewardsGranted: 1200,
          totalRewardsPending: 0,
        },
      });

      const paidBooking = await factory.createBookingWithDependencies(userId, {
        booking: { paymentStatus: "PAID", status: "COMPLETED" },
      });
      await databaseService.booking.update({
        where: { id: paidBooking.id },
        data: { referralCreditsUsed: 200 },
      });

      const unpaidBooking = await factory.createBookingWithDependencies(userId, {
        booking: { paymentStatus: "UNPAID", status: "PENDING" },
      });
      await databaseService.booking.update({
        where: { id: unpaidBooking.id },
        data: { referralCreditsReserved: 100 },
      });

      const response = await request(app.getHttpServer())
        .get("/api/referrals/user")
        .set("Cookie", userCookie);

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body.referralCode).toBe("USRREF01");
      expect(response.body.shareLink).toContain("/auth?ref=USRREF01");
      expect(response.body.stats.totalEarned).toBe(1200);
      expect(response.body.stats.totalUsed).toBe(200);
      expect(response.body.stats.availableCredits).toBe(900);
      expect(Array.isArray(response.body.referrals)).toBe(true);
      expect(Array.isArray(response.body.rewards)).toBe(true);
    });
  });
});
