import { HttpStatus, type INestApplication } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { GlobalExceptionFilter } from "../src/common/filters/global-exception.filter";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import { DatabaseService } from "../src/modules/database/database.service";
import { TestDataFactory, uniqueEmail } from "./helpers";

const seededProfile = {
  name: "Ada Lovelace",
  phoneNumber: "+2348012345678",
  city: "Lagos",
  address: "12 Marina",
  marketingConsent: false,
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
    data: Partial<typeof seededProfile> = seededProfile,
  ): Promise<void> {
    await databaseService.user.update({
      where: { id },
      data: { ...seededProfile, ...data },
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
    const httpAdapterHost = app.get(HttpAdapterHost);
    app.useGlobalFilters(new GlobalExceptionFilter(httpAdapterHost));

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
      ...seededProfile,
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
        phoneNumber: "",
      });

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body).toEqual({
      ...seededProfile,
      address: null,
      phoneNumber: null,
    });
    expect(await persistedProfile(userId)).toEqual({
      email: userEmail,
      ...seededProfile,
      address: null,
      phoneNumber: null,
    });
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
      ...seededProfile,
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
      ...seededProfile,
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
});
