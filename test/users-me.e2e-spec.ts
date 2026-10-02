import { HttpStatus, type INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import { DatabaseService } from "../src/modules/database/database.service";
import { TestDataFactory, uniqueEmail } from "./helpers";

const twilioMocks = vi.hoisted(() => ({
  createVerification: vi.fn().mockResolvedValue({ status: "pending" }),
  createVerificationCheck: vi.fn().mockResolvedValue({ status: "approved" }),
}));

vi.mock("twilio", () => ({
  default: vi.fn(() => ({
    verify: {
      v2: {
        services: vi.fn(() => ({
          verifications: { create: twilioMocks.createVerification },
          verificationChecks: { create: twilioMocks.createVerificationCheck },
        })),
      },
    },
  })),
}));

const seededProfile = {
  name: "Ada Lovelace",
  phoneNumber: "+2348012345678",
  phoneVerified: false,
  city: "Lagos",
  address: "12 Marina",
  marketingConsent: false,
};

const persistedSeed = {
  name: seededProfile.name,
  phoneNumber: seededProfile.phoneNumber,
  city: seededProfile.city,
  address: seededProfile.address,
  marketingConsent: seededProfile.marketingConsent,
};

describe("Current user profile E2E Tests", () => {
  let app: INestApplication;
  let databaseService: DatabaseService;
  let factory: TestDataFactory;
  let userCookie: string;
  let userId: string;
  let userEmail: string;

  async function seedProfile(
    id: string,
    data: Partial<typeof persistedSeed> = persistedSeed,
  ): Promise<void> {
    await databaseService.user.update({
      where: { id },
      data: { ...persistedSeed, ...data },
    });
  }

  async function persistedProfile(id: string) {
    return databaseService.user.findUnique({
      where: { id },
      select: {
        email: true,
        name: true,
        phoneNumber: true,
        city: true,
        address: true,
        marketingConsent: true,
      },
    });
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuthEmailService)
      .useValue({ sendOTPEmail: vi.fn().mockResolvedValue(undefined) })
      .compile();

    app = moduleFixture.createNestApplication({ logger: false });

    databaseService = app.get(DatabaseService);
    factory = new TestDataFactory(databaseService, app);
    await app.init();

    userEmail = uniqueEmail("users-me");
    const auth = await factory.authenticateAndGetUser(userEmail, "user");
    userCookie = auth.cookie;
    userId = auth.user.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /api/users/me requires authentication", async () => {
    const response = await request(app.getHttpServer()).get("/api/users/me");

    expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
  });

  it("PATCH /api/users/me requires authentication", async () => {
    const response = await request(app.getHttpServer())
      .patch("/api/users/me")
      .send({ city: "Lagos" });

    expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
  });

  it("GET /api/users/me returns editable profile fields", async () => {
    await seedProfile(userId);

    const response = await request(app.getHttpServer())
      .get("/api/users/me")
      .set("Cookie", userCookie);

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body).toEqual(seededProfile);
    expect(response.body).not.toHaveProperty("email");
  });

  it("PATCH /api/users/me updates only provided fields and leaves email unchanged", async () => {
    await seedProfile(userId);

    const response = await request(app.getHttpServer())
      .patch("/api/users/me")
      .set("Cookie", userCookie)
      .send({
        city: "Abuja",
        marketingConsent: true,
      });

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body).toEqual({
      ...seededProfile,
      city: "Abuja",
      marketingConsent: true,
    });
    expect(await persistedProfile(userId)).toEqual({
      email: userEmail,
      ...persistedSeed,
      city: "Abuja",
      marketingConsent: true,
    });
  });

  it("PATCH /api/users/me clears string fields with null or empty string", async () => {
    await seedProfile(userId);

    const response = await request(app.getHttpServer())
      .patch("/api/users/me")
      .set("Cookie", userCookie)
      .send({
        address: null,
      });

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body).toEqual({
      ...seededProfile,
      address: null,
    });
    expect(await persistedProfile(userId)).toEqual({
      email: userEmail,
      ...persistedSeed,
      address: null,
    });
  });

  it("PATCH /api/users/me rejects phoneNumber", async () => {
    await seedProfile(userId);
    const verifiedAt = new Date("2026-01-01T00:00:00.000Z");
    await databaseService.user.update({
      where: { id: userId },
      data: { phoneVerifiedAt: verifiedAt },
    });

    const response = await request(app.getHttpServer())
      .patch("/api/users/me")
      .set("Cookie", userCookie)
      .send({ phoneNumber: "+2348099999999" });

    expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    const persisted = await databaseService.user.findUnique({
      where: { id: userId },
      select: { phoneNumber: true, phoneVerifiedAt: true },
    });
    expect(persisted).toEqual({
      phoneNumber: seededProfile.phoneNumber,
      phoneVerifiedAt: verifiedAt,
    });
  });

  it("PATCH /api/users/me keeps phoneVerifiedAt when the phone number is omitted", async () => {
    const verifiedAt = new Date("2026-01-01T00:00:00.000Z");
    await seedProfile(userId);
    await databaseService.user.update({
      where: { id: userId },
      data: { phoneVerifiedAt: verifiedAt },
    });

    const response = await request(app.getHttpServer())
      .patch("/api/users/me")
      .set("Cookie", userCookie)
      .send({ city: "Abuja" });

    expect(response.status).toBe(HttpStatus.OK);
    const persisted = await databaseService.user.findUnique({
      where: { id: userId },
      select: { city: true, phoneVerifiedAt: true },
    });
    expect(persisted?.city).toBe("Abuja");
    expect(persisted?.phoneVerifiedAt).toEqual(verifiedAt);
  });

  it("PATCH /api/users/me rejects email", async () => {
    await seedProfile(userId);

    const response = await request(app.getHttpServer())
      .patch("/api/users/me")
      .set("Cookie", userCookie)
      .send({
        name: "Changed",
        email: "attacker@example.com",
      });

    expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    expect(await persistedProfile(userId)).toEqual({
      email: userEmail,
      ...persistedSeed,
    });
  });

  it("PATCH /api/users/me rejects an empty body", async () => {
    await seedProfile(userId);

    const response = await request(app.getHttpServer())
      .patch("/api/users/me")
      .set("Cookie", userCookie)
      .send({});

    expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    expect(await persistedProfile(userId)).toEqual({
      email: userEmail,
      ...persistedSeed,
    });
  });

  it("PATCH /api/users/me cannot change another user's profile", async () => {
    const otherEmail = uniqueEmail("users-me-other");
    const otherAuth = await factory.authenticateAndGetUser(otherEmail, "user");
    await seedProfile(userId, { city: "Lagos" });
    await seedProfile(otherAuth.user.id, { city: "Port Harcourt" });

    const response = await request(app.getHttpServer())
      .patch("/api/users/me")
      .set("Cookie", otherAuth.cookie)
      .send({ city: "Kano" });

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body.city).toBe("Kano");
    expect(await persistedProfile(userId)).toMatchObject({ email: userEmail, city: "Lagos" });
    expect(await persistedProfile(otherAuth.user.id)).toMatchObject({
      email: otherEmail,
      city: "Kano",
    });
  });

  it("POST /api/users/me/phone-verifications requires the current session", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/users/me/phone-verifications")
      .send({ phoneNumber: "+2348011111111", userId: userId });

    expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    expect(twilioMocks.createVerification).not.toHaveBeenCalled();
  });

  it("POST /api/users/me/phone-verifications rejects an invalid phone number", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/users/me/phone-verifications")
      .set("Cookie", userCookie)
      .send({ phoneNumber: "08012345678" });

    expect(response.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it("sends and checks a code for the authenticated user only", async () => {
    const phoneNumber = "+2348094444444";
    twilioMocks.createVerification.mockClear();
    twilioMocks.createVerificationCheck.mockClear();

    const sent = await request(app.getHttpServer())
      .post("/api/users/me/phone-verifications")
      .set("Cookie", userCookie)
      .send({ phoneNumber, userId: "someone-else" });

    expect(sent.status).toBe(HttpStatus.CREATED);
    expect(sent.body).toEqual({ status: "PENDING", phoneNumber: "**********4444" });
    expect(twilioMocks.createVerification).toHaveBeenCalledWith({
      channel: "sms",
      to: phoneNumber,
    });

    const checked = await request(app.getHttpServer())
      .post("/api/users/me/phone-verification-checks")
      .set("Cookie", userCookie)
      .send({ phoneNumber, code: "123456" });

    expect(checked.status).toBe(HttpStatus.CREATED);
    expect(checked.body).toEqual({ status: "VERIFIED", phoneNumber: "**********4444" });

    const profile = await request(app.getHttpServer())
      .get("/api/users/me")
      .set("Cookie", userCookie);
    expect(profile.body.phoneNumber).toBe(phoneNumber);
    expect(profile.body.phoneVerified).toBe(true);
  });

  it("POST /api/users/me/phone-verification-checks maps an invalid code", async () => {
    twilioMocks.createVerificationCheck.mockResolvedValueOnce({ status: "pending" });

    const response = await request(app.getHttpServer())
      .post("/api/users/me/phone-verification-checks")
      .set("Cookie", userCookie)
      .send({ phoneNumber: "+2348095555555", code: "000000" });

    expect(response.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(response.body.errorCode).toBe("PHONE_VERIFICATION_CODE_INVALID");
  });

  it("POST /api/users/me/phone-verification-checks conflicts when the verified number is taken", async () => {
    const phoneNumber = "+2348096666666";
    const other = await factory.authenticateAndGetUser(uniqueEmail("users-me-phone"), "user");
    twilioMocks.createVerificationCheck.mockResolvedValue({ status: "approved" });

    const first = await request(app.getHttpServer())
      .post("/api/users/me/phone-verification-checks")
      .set("Cookie", userCookie)
      .send({ phoneNumber, code: "123456" });
    const second = await request(app.getHttpServer())
      .post("/api/users/me/phone-verification-checks")
      .set("Cookie", other.cookie)
      .send({ phoneNumber, code: "123456" });

    expect(first.status).toBe(HttpStatus.CREATED);
    expect(second.status).toBe(HttpStatus.CONFLICT);
    expect(second.body.errorCode).toBe("PHONE_VERIFICATION_NUMBER_UNAVAILABLE");
  });
});
