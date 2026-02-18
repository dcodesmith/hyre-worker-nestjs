import { HttpStatus, INestApplication } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { Test, TestingModule } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { GlobalExceptionFilter } from "../src/common/filters/global-exception.filter";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import { DatabaseService } from "../src/modules/database/database.service";
import { TestDataFactory, uniqueEmail } from "./helpers";

describe("Auth E2E Tests", () => {
  let app: INestApplication;
  let databaseService: DatabaseService;
  let factory: TestDataFactory;
  let mockSendOTPEmail: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    mockSendOTPEmail = vi.fn().mockResolvedValue(undefined);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuthEmailService)
      .useValue({ sendOTPEmail: mockSendOTPEmail })
      .compile();

    app = moduleFixture.createNestApplication({
      logger: false,
    });

    const httpAdapterHost = app.get(HttpAdapterHost);
    app.useGlobalFilters(new GlobalExceptionFilter(httpAdapterHost));

    databaseService = app.get(DatabaseService);
    factory = new TestDataFactory(databaseService);

    await app.init();

    await factory.clearRateLimits();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("GET /auth/session", () => {
    it("should return 401 when not authenticated", async () => {
      const response = await request(app.getHttpServer()).get("/auth/session");

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
      expect(response.body.detail).toBe("Not authenticated");
    });

    it("should return 401 with invalid cookie", async () => {
      const response = await request(app.getHttpServer())
        .get("/auth/session")
        .set("Cookie", "better-auth.session_token=invalid-token");

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
      expect(response.body.detail).toBe("Not authenticated");
    });
  });

  describe("POST /auth/api/email-otp/send-verification-otp", () => {
    beforeEach(async () => {
      await factory.clearRateLimits();
    });

    it("should send OTP to email and create verification record (web client)", async () => {
      const testEmail = uniqueEmail("otp-test-web");

      const response = await request(app.getHttpServer())
        .post("/auth/api/email-otp/send-verification-otp")
        .set("Origin", "http://localhost:5173")
        .set("Referer", "http://localhost:5173/auth")
        .send({ email: testEmail, type: "sign-in" });

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body.success).toBe(true);

      const verification = await databaseService.verification.findFirst({
        where: { identifier: `sign-in-otp-${testEmail}` },
        orderBy: { createdAt: "desc" },
      });

      expect(verification).toBeDefined();
      expect(verification?.identifier).toBe(`sign-in-otp-${testEmail}`);
      expect(verification?.value).toBeDefined();
      expect(verification?.value.split(":")[0].length).toBe(6);
    });
  });

  describe("POST /auth/api/sign-in/email-otp (verify)", () => {
    beforeEach(async () => {
      await factory.clearRateLimits();
    });

    it("should reject invalid OTP", async () => {
      const testEmail = uniqueEmail("invalid-otp");

      await request(app.getHttpServer())
        .post("/auth/api/email-otp/send-verification-otp")
        .set("X-Client-Type", "mobile")
        .send({ email: testEmail, type: "sign-in" });

      const response = await request(app.getHttpServer())
        .post("/auth/api/sign-in/email-otp")
        .set("X-Client-Type", "mobile")
        .send({ email: testEmail, otp: "000000" });

      expect(response.body).toEqual({ code: "INVALID_OTP", message: "Invalid OTP" });
      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it("should verify correct OTP and return session with cookies", async () => {
      const testEmail = uniqueEmail("verify-otp");

      const sendResponse = await request(app.getHttpServer())
        .post("/auth/api/email-otp/send-verification-otp")
        .set("X-Client-Type", "mobile")
        .send({ email: testEmail, type: "sign-in" });

      expect(sendResponse.status).toBe(HttpStatus.OK);
      expect(sendResponse.body.success).toBe(true);

      const verification = await databaseService.verification.findFirst({
        where: { identifier: `sign-in-otp-${testEmail}` },
        orderBy: { createdAt: "desc" },
      });

      expect(verification).toBeDefined();
      expect(verification?.value).toBeDefined();

      const otp = verification?.value.split(":")[0];

      const verifyResponse = await request(app.getHttpServer())
        .post("/auth/api/sign-in/email-otp")
        .set("X-Client-Type", "mobile")
        .send({ email: testEmail, otp });

      expect(verifyResponse.status).toBe(HttpStatus.OK);
      expect(verifyResponse.body.user).toBeDefined();
      expect(verifyResponse.body.user.email).toBe(testEmail);
      expect(verifyResponse.body.token).toBeDefined();

      const cookies = verifyResponse.headers["set-cookie"];
      expect(cookies).toBeDefined();
    });
  });

  describe("Authenticated session flow", () => {
    beforeEach(async () => {
      await factory.clearRateLimits();
    });

    it("should complete full auth flow and access protected session endpoint", async () => {
      const testEmail = uniqueEmail("auth-flow");

      const sendResponse = await request(app.getHttpServer())
        .post("/auth/api/email-otp/send-verification-otp")
        .set("X-Client-Type", "mobile")
        .send({ email: testEmail, type: "sign-in" });

      expect(sendResponse.status).toBe(HttpStatus.OK);
      expect(sendResponse.body.success).toBe(true);

      const verification = await databaseService.verification.findFirst({
        where: { identifier: `sign-in-otp-${testEmail}` },
        orderBy: { createdAt: "desc" },
      });

      expect(verification?.value).toBeDefined();
      const otp = verification?.value.split(":")[0];

      const verifyResponse = await request(app.getHttpServer())
        .post("/auth/api/sign-in/email-otp")
        .set("X-Client-Type", "mobile")
        .send({ email: testEmail, otp });

      expect(verifyResponse.status).toBe(HttpStatus.OK);
      expect(verifyResponse.body.token).toBeDefined();

      const cookies = verifyResponse.headers["set-cookie"];
      expect(cookies).toBeDefined();
      const sessionCookie = Array.isArray(cookies) ? cookies.join("; ") : cookies;

      const sessionResponse = await request(app.getHttpServer())
        .get("/auth/session")
        .set("Cookie", sessionCookie);

      expect(sessionResponse.status).toBe(HttpStatus.OK);
      expect(sessionResponse.body.user).toBeDefined();
      expect(sessionResponse.body.user.email).toBe(testEmail);
      expect(sessionResponse.body.session).toBeDefined();
      expect(sessionResponse.body.session.userId).toBe(sessionResponse.body.user.id);
    });

    it("should return user roles in session response", async () => {
      const testEmail = uniqueEmail("session-with-roles");

      const sendResponse = await request(app.getHttpServer())
        .post("/auth/api/email-otp/send-verification-otp")
        .set("Origin", "http://localhost:3000")
        .set("Referer", "http://localhost:3000/fleet-owner/signup")
        .send({ email: testEmail, type: "sign-in", role: "fleetOwner" });

      expect(sendResponse.status).toBe(HttpStatus.OK);

      const verification = await databaseService.verification.findFirst({
        where: { identifier: `sign-in-otp-${testEmail}` },
        orderBy: { createdAt: "desc" },
      });
      const otp = verification?.value.split(":")[0];

      const verifyResponse = await request(app.getHttpServer())
        .post("/auth/api/sign-in/email-otp")
        .set("Origin", "http://localhost:3000")
        .set("Referer", "http://localhost:3000/fleet-owner/signup")
        .send({ email: testEmail, otp, role: "fleetOwner" });

      expect(verifyResponse.status).toBe(HttpStatus.OK);

      const cookies = verifyResponse.headers["set-cookie"];
      const sessionCookie = Array.isArray(cookies) ? cookies.join("; ") : cookies;

      const sessionResponse = await request(app.getHttpServer())
        .get("/auth/session")
        .set("Cookie", sessionCookie);

      expect(sessionResponse.status).toBe(HttpStatus.OK);
      expect(sessionResponse.body.user).toBeDefined();
      expect(sessionResponse.body.user.email).toBe(testEmail);

      expect(sessionResponse.body.user.roles).toBeDefined();
      expect(Array.isArray(sessionResponse.body.user.roles)).toBe(true);
      expect(sessionResponse.body.user.roles).toContain("fleetOwner");
    });
  });

  describe.skip("Rate limiting", () => {
    beforeEach(async () => {
      await factory.clearRateLimits();
    });

    // TODO: Investigate rate limiting behavior in test environment
    // Rate limiting is enabled but doesn't trigger as expected in E2E tests
    // This may be due to Better Auth's rate limit key generation or timing issues
    it("should enforce rate limiting on OTP send endpoint", async () => {
      const rateLimitEmail = uniqueEmail("rate-limit");

      // Send multiple requests sequentially to same email
      // Rate limit is 5 requests per 60 seconds for this endpoint
      const responses: request.Response[] = [];
      for (let i = 0; i < 7; i++) {
        const response = await request(app.getHttpServer())
          .post("/auth/api/email-otp/send-verification-otp")
          .set("X-Client-Type", "mobile")
          .send({ email: rateLimitEmail, type: "sign-in" });
        responses.push(response);
      }

      // First 5 should succeed, the rest should be rate limited
      const successCount = responses.filter((r) => r.status === HttpStatus.OK).length;
      const rateLimitedCount = responses.filter(
        (r) => r.status === HttpStatus.TOO_MANY_REQUESTS,
      ).length;

      expect(successCount).toBe(5);
      expect(rateLimitedCount).toBe(2);
    });
  });

  describe("Role validation in OTP flow", () => {
    beforeEach(async () => {
      await factory.clearRateLimits();
    });

    describe("Protected roles (admin, staff)", () => {
      it("should reject admin role for existing user who does not have it", async () => {
        const testEmail = uniqueEmail("no-admin-role");

        const sendResponse = await request(app.getHttpServer())
          .post("/auth/api/email-otp/send-verification-otp")
          .set("X-Client-Type", "mobile")
          .send({ email: testEmail, type: "sign-in", role: "user" });

        expect(sendResponse.status).toBe(HttpStatus.OK);

        const verification = await databaseService.verification.findFirst({
          where: { identifier: `sign-in-otp-${testEmail}` },
          orderBy: { createdAt: "desc" },
        });
        const otp = verification?.value.split(":")[0];

        await request(app.getHttpServer())
          .post("/auth/api/sign-in/email-otp")
          .set("X-Client-Type", "mobile")
          .send({ email: testEmail, otp, role: "user" });

        // Clear rate limits for next request
        await factory.clearRateLimits();

        // Now try to request admin role for this user from admin referer
        // This should fail because user doesn't have admin role
        const adminResponse = await request(app.getHttpServer())
          .post("/auth/api/email-otp/send-verification-otp")
          .set("Origin", "http://localhost:3000")
          .set("Referer", "http://localhost:3000/admin/dashboard")
          .send({ email: testEmail, type: "sign-in", role: "admin" });

        expect(adminResponse.status).toBe(HttpStatus.FORBIDDEN);
        expect(adminResponse.body.message).toContain('does not have the "admin" role');
      });

      it("should reject admin role for new user even from valid admin path", async () => {
        const testEmail = uniqueEmail("new-user-admin");

        // Ensure user doesn't exist
        const existingUser = await databaseService.user.findUnique({
          where: { email: testEmail },
        });
        expect(existingUser).toBeNull();

        // Try to sign up as admin from valid /admin path
        // This should fail because new users cannot self-assign protected roles
        const response = await request(app.getHttpServer())
          .post("/auth/api/email-otp/send-verification-otp")
          .set("Origin", "http://localhost:3000")
          .set("Referer", "http://localhost:3000/admin/login")
          .send({ email: testEmail, type: "sign-in", role: "admin" });

        expect(response.status).toBe(HttpStatus.FORBIDDEN);
        expect(response.body.message).toContain('does not have the "admin" role');

        const userAfterRequest = await databaseService.user.findUnique({
          where: { email: testEmail },
        });
        expect(userAfterRequest).toBeNull();
      });

      it("should reject staff role for new user even from valid admin path", async () => {
        const testEmail = uniqueEmail("new-user-staff");

        // Try to sign up as staff from valid /admin path
        const response = await request(app.getHttpServer())
          .post("/auth/api/email-otp/send-verification-otp")
          .set("Origin", "http://localhost:3000")
          .set("Referer", "http://localhost:3000/admin/staff-login")
          .send({ email: testEmail, type: "sign-in", role: "staff" });

        expect(response.status).toBe(HttpStatus.FORBIDDEN);
        expect(response.body.message).toContain('does not have the "staff" role');

        const userAfterRequest = await databaseService.user.findUnique({
          where: { email: testEmail },
        });
        expect(userAfterRequest).toBeNull();
      });

      it("should allow admin role for existing user who has it", async () => {
        const testEmail = uniqueEmail("existing-admin");

        const sendResponse = await request(app.getHttpServer())
          .post("/auth/api/email-otp/send-verification-otp")
          .set("X-Client-Type", "mobile")
          .send({ email: testEmail, type: "sign-in", role: "user" });

        expect(sendResponse.status).toBe(HttpStatus.OK);

        const verification = await databaseService.verification.findFirst({
          where: { identifier: `sign-in-otp-${testEmail}` },
          orderBy: { createdAt: "desc" },
        });
        const otp = verification?.value.split(":")[0];

        await request(app.getHttpServer())
          .post("/auth/api/sign-in/email-otp")
          .set("X-Client-Type", "mobile")
          .send({ email: testEmail, otp, role: "user" });

        // Manually grant admin role to simulate admin-assigned user
        await databaseService.user.update({
          where: { email: testEmail },
          data: { roles: { connect: { name: "admin" } } },
        });

        await factory.clearRateLimits();

        // Now request admin role - should succeed since user has the role
        const adminResponse = await request(app.getHttpServer())
          .post("/auth/api/email-otp/send-verification-otp")
          .set("Origin", "http://localhost:3000")
          .set("Referer", "http://localhost:3000/admin/dashboard")
          .send({ email: testEmail, type: "sign-in", role: "admin" });

        expect(adminResponse.status).toBe(HttpStatus.OK);
        expect(adminResponse.body.success).toBe(true);
      });
    });

    describe("Default role behavior", () => {
      it("should default to user role when no role is specified", async () => {
        const testEmail = uniqueEmail("default-role");

        const sendResponse = await request(app.getHttpServer())
          .post("/auth/api/email-otp/send-verification-otp")
          .set("X-Client-Type", "mobile")
          .send({ email: testEmail, type: "sign-in" }); // No role specified

        expect(sendResponse.status).toBe(HttpStatus.OK);

        const verification = await databaseService.verification.findFirst({
          where: { identifier: `sign-in-otp-${testEmail}` },
          orderBy: { createdAt: "desc" },
        });
        const otp = verification?.value.split(":")[0];

        const verifyResponse = await request(app.getHttpServer())
          .post("/auth/api/sign-in/email-otp")
          .set("X-Client-Type", "mobile")
          .send({ email: testEmail, otp }); // No role specified

        expect(verifyResponse.status).toBe(HttpStatus.OK);

        // User should have the default 'user' role
        const user = await databaseService.user.findUnique({
          where: { email: testEmail },
          include: { roles: { select: { name: true } } },
        });

        expect(user?.roles.some(({ name }) => name === "user")).toBe(true);
      });
    });
  });
});
