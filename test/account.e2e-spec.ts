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

describe("Account E2E Tests", () => {
  let app: INestApplication;
  let databaseService: DatabaseService;
  let factory: TestDataFactory;
  let userCookie: string;

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

    const auth = await factory.authenticateAndGetUser(uniqueEmail("account-delete-user"), "user");
    userCookie = auth.cookie;
  });

  afterAll(async () => {
    await app.close();
  });

  it("POST /api/account/delete requires authentication", async () => {
    const response = await request(app.getHttpServer()).post("/api/account/delete");

    expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
  });

  it("POST /api/account/delete returns success for authenticated users", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/account/delete")
      .set("Cookie", userCookie);

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body.success).toBe(true);
  });
});
