import { HttpStatus, type INestApplication } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { GlobalExceptionFilter } from "../src/common/filters/global-exception.filter";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import { DatabaseService } from "../src/modules/database/database.service";
import { TestDataFactory, uniqueEmail } from "./helpers";

describe("Promotions E2E Tests", () => {
  let app: INestApplication;
  let databaseService: DatabaseService;
  let factory: TestDataFactory;
  let fleetOwnerCookie: string;
  let nonFleetOwnerCookie: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuthEmailService)
      .useValue({ sendOTPEmail: async () => undefined })
      .compile();

    app = moduleFixture.createNestApplication({ logger: false });
    const httpAdapterHost = app.get(HttpAdapterHost);
    app.useGlobalFilters(new GlobalExceptionFilter(httpAdapterHost));
    await app.init();

    databaseService = app.get(DatabaseService);
    factory = new TestDataFactory(databaseService, app);

    const fleetOwnerAuth = await factory.authenticateAndGetUser(uniqueEmail("promo-owner"), "user");
    await factory.assignRole(fleetOwnerAuth.user.id, "fleetOwner");
    fleetOwnerCookie = fleetOwnerAuth.cookie;

    const nonFleetOwnerAuth = await factory.authenticateAndGetUser(
      uniqueEmail("promo-user"),
      "user",
    );
    nonFleetOwnerCookie = nonFleetOwnerAuth.cookie;
  });

  afterAll(async () => {
    await app?.close();
  });

  it("rejects create promotion for non-fleet-owner", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/fleet-owner/promotions")
      .set("Cookie", nonFleetOwnerCookie)
      .send({
        name: "Promo",
        discountValue: 10,
        startDate: "2026-04-11",
        endDate: "2026-04-14",
      });

    expect(response.status).toBe(HttpStatus.FORBIDDEN);
  });

  it("creates, lists, and deactivates promotions for fleet owner", async () => {
    const createResponse = await request(app.getHttpServer())
      .post("/api/fleet-owner/promotions")
      .set("Cookie", fleetOwnerCookie)
      .send({
        name: "Spring Promo",
        discountValue: 10,
        startDate: "2026-04-11",
        endDate: "2026-04-14",
      });

    expect(createResponse.status).toBe(HttpStatus.CREATED);
    expect(createResponse.body.id).toBeDefined();
    expect(createResponse.body.isActive).toBe(true);

    const listResponse = await request(app.getHttpServer())
      .get("/api/fleet-owner/promotions")
      .set("Cookie", fleetOwnerCookie);

    expect(listResponse.status).toBe(HttpStatus.OK);
    expect(Array.isArray(listResponse.body)).toBe(true);
    expect(listResponse.body.length).toBeGreaterThanOrEqual(1);

    const promotionId = createResponse.body.id as string;
    const deactivateResponse = await request(app.getHttpServer())
      .patch(`/api/fleet-owner/promotions/${promotionId}/deactivate`)
      .set("Cookie", fleetOwnerCookie);

    expect(deactivateResponse.status).toBe(HttpStatus.OK);
    expect(deactivateResponse.body.isActive).toBe(false);
  });
});
