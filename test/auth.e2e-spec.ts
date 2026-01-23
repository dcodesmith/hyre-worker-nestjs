import { HttpStatus, INestApplication } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { Test, TestingModule } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { GlobalExceptionFilter } from "../src/common/filters/global-exception.filter";
import { DatabaseService } from "../src/modules/database/database.service";

describe("Auth E2E Tests", () => {
  let app: INestApplication;
  let databaseService: DatabaseService;
  let testId: number;

  // Generate unique email for each test to avoid conflicts
  const uniqueEmail = (prefix: string) => `${prefix}-${testId}-${Date.now()}@example.com`;

  // Helper to clear rate limits before a test
  const clearRateLimits = async () => {
    const deleted = await databaseService.rateLimit.deleteMany({});
    console.log(`Cleared ${deleted.count} rate limit records`);
  };

  // Seed roles once at test suite startup
  const seedRoles = async () => {
    const roles = ["user", "fleetOwner", "admin", "staff"];
    for (const roleName of roles) {
      await databaseService.role.upsert({
        where: { name: roleName },
        update: {},
        create: { name: roleName, description: `${roleName} role` },
      });
    }
    console.log("Seeded roles in database");
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();

    // Register global exception filter (same as in main.ts)
    const httpAdapterHost = app.get(HttpAdapterHost);
    app.useGlobalFilters(new GlobalExceptionFilter(httpAdapterHost));

    databaseService = app.get(DatabaseService);

    await app.init();

    // Seed roles once at test suite startup
    await seedRoles();

    // Clear any existing rate limits from previous test runs
    await clearRateLimits();
  });

  beforeEach(() => {
    testId = Math.floor(Math.random() * 100000);
  });

  afterAll(async () => {
    await app.close();
  });

  describe("GET /auth/session", () => {
    it("should return 401 when not authenticated", async () => {
      const response = await request(app.getHttpServer()).get("/auth/session");

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
      expect(response.body.message).toBe("Not authenticated");
    });

    it("should return 401 with invalid cookie", async () => {
      const response = await request(app.getHttpServer())
        .get("/auth/session")
        .set("Cookie", "better-auth.session_token=invalid-token");

      // Log rate limit records after request
      const rateLimitCount = await databaseService.rateLimit.count();
      console.log(`Rate limit records in DB: ${rateLimitCount}`);
      if (response.status === 429) {
        console.log("Rate limit response body:", response.body);
      }

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
      expect(response.body.message).toBe("Not authenticated");
    });
  });

  describe("POST /auth/api/email-otp/send-verification-otp", () => {
    beforeEach(async () => {
      await clearRateLimits();
    });

    it("should send OTP to email and create verification record", async () => {
      const testEmail = uniqueEmail("otp-test");

      const response = await request(app.getHttpServer())
        .post("/auth/api/email-otp/send-verification-otp")
        .set("X-Client-Type", "mobile")
        .send({ email: testEmail, type: "sign-in" });

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body.success).toBe(true);

      // Check verification exists in database
      // Better Auth stores with identifier format: sign-in-otp-{email}
      const verification = await databaseService.verification.findFirst({
        where: { identifier: `sign-in-otp-${testEmail}` },
        orderBy: { createdAt: "desc" },
      });

      expect(verification).toBeDefined();
      expect(verification?.identifier).toBe(`sign-in-otp-${testEmail}`);
      expect(verification?.value).toBeDefined();
      // OTP is stored as "otp:attempts" format (e.g., "123456:0")
      expect(verification?.value.split(":")[0].length).toBe(6);
    });

    it("should reject invalid email format", async () => {
      const response = await request(app.getHttpServer())
        .post("/auth/api/email-otp/send-verification-otp")
        .set("X-Client-Type", "mobile")
        .send({ email: "not-an-email", type: "sign-in" });

      // Better Auth returns 400 for validation errors
      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    });
  });

  describe("POST /auth/api/sign-in/email-otp (verify)", () => {
    beforeEach(async () => {
      await clearRateLimits();
    });

    it("should reject invalid OTP", async () => {
      const testEmail = uniqueEmail("invalid-otp");

      // First, send OTP to create verification
      await request(app.getHttpServer())
        .post("/auth/api/email-otp/send-verification-otp")
        .set("X-Client-Type", "mobile")
        .send({ email: testEmail, type: "sign-in" });

      // Try to verify with wrong OTP
      const response = await request(app.getHttpServer())
        .post("/auth/api/sign-in/email-otp")
        .set("X-Client-Type", "mobile")
        .send({ email: testEmail, otp: "000000" });

      // Should fail verification
      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it("should verify correct OTP and return session with cookies", async () => {
      const testEmail = uniqueEmail("verify-otp");

      // Send OTP
      const sendResponse = await request(app.getHttpServer())
        .post("/auth/api/email-otp/send-verification-otp")
        .set("X-Client-Type", "mobile")
        .send({ email: testEmail, type: "sign-in" });

      expect(sendResponse.status).toBe(HttpStatus.OK);
      expect(sendResponse.body.success).toBe(true);

      // Get OTP from database - Better Auth stores as "sign-in-otp-{email}"
      const verification = await databaseService.verification.findFirst({
        where: { identifier: `sign-in-otp-${testEmail}` },
        orderBy: { createdAt: "desc" },
      });

      expect(verification).toBeDefined();
      expect(verification?.value).toBeDefined();

      // Extract OTP from "otp:attempts" format
      const otp = verification?.value.split(":")[0];

      // Verify OTP - this creates user and session
      const verifyResponse = await request(app.getHttpServer())
        .post("/auth/api/sign-in/email-otp")
        .set("X-Client-Type", "mobile")
        .send({ email: testEmail, otp });

      expect(verifyResponse.status).toBe(HttpStatus.OK);
      expect(verifyResponse.body.user).toBeDefined();
      expect(verifyResponse.body.user.email).toBe(testEmail);
      expect(verifyResponse.body.token).toBeDefined();

      // Should set session cookie
      const cookies = verifyResponse.headers["set-cookie"];
      expect(cookies).toBeDefined();
    });
  });

  describe("Authenticated session flow", () => {
    beforeEach(async () => {
      await clearRateLimits();
    });

    it("should complete full auth flow and access protected session endpoint", async () => {
      const testEmail = uniqueEmail("auth-flow");

      // Step 1: Send OTP
      const sendResponse = await request(app.getHttpServer())
        .post("/auth/api/email-otp/send-verification-otp")
        .set("X-Client-Type", "mobile")
        .send({ email: testEmail, type: "sign-in" });

      expect(sendResponse.status).toBe(HttpStatus.OK);
      expect(sendResponse.body.success).toBe(true);

      // Step 2: Get OTP from database
      const verification = await databaseService.verification.findFirst({
        where: { identifier: `sign-in-otp-${testEmail}` },
        orderBy: { createdAt: "desc" },
      });

      expect(verification?.value).toBeDefined();
      const otp = verification?.value.split(":")[0];

      // Step 3: Verify OTP and sign in
      const verifyResponse = await request(app.getHttpServer())
        .post("/auth/api/sign-in/email-otp")
        .set("X-Client-Type", "mobile")
        .send({ email: testEmail, otp });

      expect(verifyResponse.status).toBe(HttpStatus.OK);
      expect(verifyResponse.body.token).toBeDefined();

      // Extract session cookie
      const cookies = verifyResponse.headers["set-cookie"];
      expect(cookies).toBeDefined();
      const sessionCookie = Array.isArray(cookies) ? cookies.join("; ") : cookies;

      // Step 4: Access session endpoint with cookie
      const sessionResponse = await request(app.getHttpServer())
        .get("/auth/session")
        .set("Cookie", sessionCookie);

      expect(sessionResponse.status).toBe(HttpStatus.OK);
      expect(sessionResponse.body.user).toBeDefined();
      expect(sessionResponse.body.user.email).toBe(testEmail);
      expect(sessionResponse.body.session).toBeDefined();
      expect(sessionResponse.body.session.userId).toBe(sessionResponse.body.user.id);
    });
  });

  describe("Rate limiting", () => {
    beforeEach(async () => {
      await clearRateLimits();
    });

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
      await clearRateLimits();
    });

    describe("Mobile client (X-Client-Type: mobile)", () => {
      it("should allow user role for mobile client", async () => {
        const testEmail = uniqueEmail("mobile-user");

        const response = await request(app.getHttpServer())
          .post("/auth/api/email-otp/send-verification-otp")
          .set("X-Client-Type", "mobile")
          .send({ email: testEmail, type: "sign-in", role: "user" });

        expect(response.status).toBe(HttpStatus.OK);
        expect(response.body.success).toBe(true);
      });

      it.each(["fleetOwner", "admin"])("should reject %s role for mobile client", async (role) => {
        const testEmail = uniqueEmail(`mobile-${role}`);

        const response = await request(app.getHttpServer())
          .post("/auth/api/email-otp/send-verification-otp")
          .set("X-Client-Type", "mobile")
          .send({ email: testEmail, type: "sign-in", role });

        expect(response.status).toBe(HttpStatus.FORBIDDEN);
        expect(response.body.message).toContain("not allowed from this client");
      });
    });

    describe("Web client with Origin header", () => {
      it("should allow user role for web client from trusted origin", async () => {
        const testEmail = uniqueEmail("web-user");

        const response = await request(app.getHttpServer())
          .post("/auth/api/email-otp/send-verification-otp")
          .set("Origin", "http://localhost:3000")
          .send({ email: testEmail, type: "sign-in", role: "user" });

        expect(response.status).toBe(HttpStatus.OK);
        expect(response.body.success).toBe(true);
      });

      it("should reject requests from untrusted origin", async () => {
        const testEmail = uniqueEmail("untrusted-origin");

        const response = await request(app.getHttpServer())
          .post("/auth/api/email-otp/send-verification-otp")
          .set("Origin", "https://evil.com")
          .send({ email: testEmail, type: "sign-in", role: "user" });

        expect(response.status).toBe(HttpStatus.FORBIDDEN);
        expect(response.body.message).toContain("not allowed from this client");
      });
    });

    describe("Protected roles (admin, staff)", () => {
      it("should reject admin role for existing user who does not have it", async () => {
        const testEmail = uniqueEmail("no-admin-role");

        // First create a regular user
        const sendResponse = await request(app.getHttpServer())
          .post("/auth/api/email-otp/send-verification-otp")
          .set("X-Client-Type", "mobile")
          .send({ email: testEmail, type: "sign-in", role: "user" });

        expect(sendResponse.status).toBe(HttpStatus.OK);

        // Get OTP and verify to create the user
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
        await clearRateLimits();

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

        // Verify no user was created
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

        // Verify no user was created
        const userAfterRequest = await databaseService.user.findUnique({
          where: { email: testEmail },
        });
        expect(userAfterRequest).toBeNull();
      });

      it("should allow admin role for existing user who has it", async () => {
        const testEmail = uniqueEmail("existing-admin");

        // First create a regular user
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

        await clearRateLimits();

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

    describe("Role assignment after verification", () => {
      it("should assign user role after successful OTP verification", async () => {
        const testEmail = uniqueEmail("role-assign-user");

        // Send OTP with user role
        const sendResponse = await request(app.getHttpServer())
          .post("/auth/api/email-otp/send-verification-otp")
          .set("X-Client-Type", "mobile")
          .send({ email: testEmail, type: "sign-in", role: "user" });

        expect(sendResponse.status).toBe(HttpStatus.OK);

        // Get OTP from database
        const verification = await databaseService.verification.findFirst({
          where: { identifier: `sign-in-otp-${testEmail}` },
          orderBy: { createdAt: "desc" },
        });
        const otp = verification?.value.split(":")[0];

        // Verify OTP
        const verifyResponse = await request(app.getHttpServer())
          .post("/auth/api/sign-in/email-otp")
          .set("X-Client-Type", "mobile")
          .send({ email: testEmail, otp, role: "user" });

        expect(verifyResponse.status).toBe(HttpStatus.OK);
        expect(verifyResponse.body.user).toBeDefined();

        // Check that user has the role in database
        const user = await databaseService.user.findUnique({
          where: { email: testEmail },
          include: { roles: { select: { name: true } } },
        });

        expect(user).toBeDefined();
        expect(user?.roles.some((r) => r.name === "user")).toBe(true);
      });

      it("should assign fleetOwner role after successful OTP verification", async () => {
        const testEmail = uniqueEmail("role-assign-fleet");

        // Send OTP with fleetOwner role from fleet-owner path
        const sendResponse = await request(app.getHttpServer())
          .post("/auth/api/email-otp/send-verification-otp")
          .set("Origin", "http://localhost:3000")
          .set("Referer", "http://localhost:3000/fleet-owner/signup")
          .send({ email: testEmail, type: "sign-in", role: "fleetOwner" });

        expect(sendResponse.status).toBe(HttpStatus.OK);

        // Get OTP from database
        const verification = await databaseService.verification.findFirst({
          where: { identifier: `sign-in-otp-${testEmail}` },
          orderBy: { createdAt: "desc" },
        });
        const otp = verification?.value.split(":")[0];

        // Verify OTP with fleetOwner role
        const verifyResponse = await request(app.getHttpServer())
          .post("/auth/api/sign-in/email-otp")
          .set("Origin", "http://localhost:3000")
          .set("Referer", "http://localhost:3000/fleet-owner/signup")
          .send({ email: testEmail, otp, role: "fleetOwner" });

        expect(verifyResponse.status).toBe(HttpStatus.OK);
        expect(verifyResponse.body.user).toBeDefined();

        // Check that user has the fleetOwner role in database (NOT just user role)
        const user = await databaseService.user.findUnique({
          where: { email: testEmail },
          include: { roles: { select: { name: true } } },
        });

        expect(user).toBeDefined();
        expect(user?.roles.some((r) => r.name === "fleetOwner")).toBe(true);
      });
    });

    describe("Default role behavior", () => {
      it("should default to user role when no role is specified", async () => {
        const testEmail = uniqueEmail("default-role");

        // Send OTP without specifying role
        const sendResponse = await request(app.getHttpServer())
          .post("/auth/api/email-otp/send-verification-otp")
          .set("X-Client-Type", "mobile")
          .send({ email: testEmail, type: "sign-in" }); // No role specified

        expect(sendResponse.status).toBe(HttpStatus.OK);

        // Get OTP and verify
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

        expect(user?.roles.some((r) => r.name === "user")).toBe(true);
      });
    });
  });
});
