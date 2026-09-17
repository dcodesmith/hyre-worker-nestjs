import { HttpStatus, type INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import { DatabaseService } from "../src/modules/database/database.service";
import { ReferralErrorCode } from "../src/modules/referral/referral.error";
import { TestDataFactory, uniqueEmail } from "./helpers";

const programBody = {
  refereeDiscount: { type: "FIXED", amount: 10000 },
  referrerReward: { type: "FIXED", amount: 2500 },
  minimumBookingAmount: 20000,
  eligibleBookingTypes: ["DAY", "FULL_DAY"],
  referralValidityDays: 30,
  maxCreditsPerBookingAmount: 30000,
  maxCreditsPerBookingPercent: 50,
};

describe("Admin referral programme E2E Tests", () => {
  let app: INestApplication;
  let databaseService: DatabaseService;
  let factory: TestDataFactory;
  let adminCookie: string;
  let staffCookie: string;
  let userCookie: string;

  const postProgram = (cookie: string) =>
    request(app.getHttpServer())
      .post("/api/admin/referral-program")
      .set("Cookie", cookie)
      .send(programBody);

  const ensureProgram = async () => {
    const created = await postProgram(adminCookie);
    expect([HttpStatus.CREATED, HttpStatus.CONFLICT]).toContain(created.status);
    const restored = await request(app.getHttpServer())
      .patch("/api/admin/referral-program")
      .set("Cookie", adminCookie)
      .send({ status: "ACTIVE", ...programBody });
    expect(restored.status).toBe(HttpStatus.OK);
    return restored;
  };

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

    adminCookie = (await factory.createAuthenticatedAdmin(uniqueEmail("ref-prog-admin"))).cookie;
    staffCookie = (await factory.createAuthenticatedStaff(uniqueEmail("ref-prog-staff"))).cookie;
    userCookie = (await factory.authenticateAndGetUser(uniqueEmail("ref-prog-user"), "user"))
      .cookie;
  });

  afterEach(async () => {
    await factory.enableReferralProgram();
  });

  afterAll(async () => {
    await app.close();
  });

  it("POST /api/admin/referral-program requires authentication", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/admin/referral-program")
      .send(programBody);

    expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
  });

  it("POST /api/admin/referral-program rejects an ordinary user", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/admin/referral-program")
      .set("Cookie", userCookie)
      .send(programBody);

    expect(response.status).toBe(HttpStatus.FORBIDDEN);
  });

  it("POST /api/admin/referral-program rejects invalid Zod payloads", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/admin/referral-program")
      .set("Cookie", adminCookie)
      .send({ ...programBody, eligibleBookingTypes: [] });

    expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    expect(response.body.title).toBe("Validation Failed");
  });

  it("POST /api/admin/referral-program creates or starts the singleton and then conflicts", async () => {
    const first = await postProgram(adminCookie);
    expect([HttpStatus.CREATED, HttpStatus.CONFLICT]).toContain(first.status);
    if (first.status === HttpStatus.CREATED) {
      expect(first.body).toMatchObject({
        id: "default",
        status: "ACTIVE",
        refereeDiscount: { type: "FIXED", amount: 10000 },
        referrerReward: { type: "FIXED", amount: 2500 },
      });
      expect(await databaseService.referralProgramAudit.count()).toBeGreaterThanOrEqual(1);
    }

    const duplicate = await postProgram(adminCookie);
    expect(duplicate.status).toBe(HttpStatus.CONFLICT);
    expect(duplicate.body.errorCode).toBe(ReferralErrorCode.REFERRAL_PROGRAM_ALREADY_EXISTS);

    const persisted = await databaseService.referralProgram.findUnique({
      where: { id: "default" },
    });
    expect(persisted?.status).toBe("ACTIVE");
  });

  it("POST /api/admin/referral-program is allowed for staff", async () => {
    const response = await postProgram(staffCookie);
    expect([HttpStatus.CREATED, HttpStatus.CONFLICT]).toContain(response.status);
    if (response.status === HttpStatus.CREATED) {
      expect(response.body.status).toBe("ACTIVE");
    }
  });

  it("GET /api/admin/referral-program returns the configured programme", async () => {
    await ensureProgram();

    const response = await request(app.getHttpServer())
      .get("/api/admin/referral-program")
      .set("Cookie", staffCookie);

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body.id).toBe("default");
    expect(response.body.status).toBe("ACTIVE");
  });

  it("GET /api/admin/referral-program returns 404 when unconfigured", async () => {
    const existing = await databaseService.referralProgram.findUnique({
      where: { id: "default" },
    });
    if (existing) {
      return;
    }

    const response = await request(app.getHttpServer())
      .get("/api/admin/referral-program")
      .set("Cookie", adminCookie);

    expect(response.status).toBe(HttpStatus.NOT_FOUND);
    expect(response.body.errorCode).toBe(ReferralErrorCode.REFERRAL_PROGRAM_NOT_FOUND);
  });

  it("PATCH /api/admin/referral-program pauses, resumes, and edits values", async () => {
    await ensureProgram();

    const paused = await request(app.getHttpServer())
      .patch("/api/admin/referral-program")
      .set("Cookie", adminCookie)
      .send({ status: "PAUSED" });
    expect(paused.status).toBe(HttpStatus.OK);
    expect(paused.body.status).toBe("PAUSED");

    const resumed = await request(app.getHttpServer())
      .patch("/api/admin/referral-program")
      .set("Cookie", staffCookie)
      .send({ status: "ACTIVE", minimumBookingAmount: 25000 });
    expect(resumed.status).toBe(HttpStatus.OK);
    expect(resumed.body.status).toBe("ACTIVE");
    expect(resumed.body.minimumBookingAmount).toBe(25000);
  });

  it("PATCH /api/admin/referral-program rejects an empty body", async () => {
    await ensureProgram();

    const response = await request(app.getHttpServer())
      .patch("/api/admin/referral-program")
      .set("Cookie", adminCookie)
      .send({});

    expect(response.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it("GET /api/admin/referral-program/history paginates audit rows", async () => {
    await ensureProgram();
    await request(app.getHttpServer())
      .patch("/api/admin/referral-program")
      .set("Cookie", adminCookie)
      .send({ status: "PAUSED" });
    await request(app.getHttpServer())
      .patch("/api/admin/referral-program")
      .set("Cookie", adminCookie)
      .send({ status: "ACTIVE" });

    const response = await request(app.getHttpServer())
      .get("/api/admin/referral-program/history")
      .query({ page: 1, pageSize: 1 })
      .set("Cookie", adminCookie);

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.pagination.page).toBe(1);
    expect(response.body.pagination.pageSize).toBe(1);
    expect(response.body.pagination.totalItems).toBeGreaterThanOrEqual(2);
    expect(response.body.pagination.totalPages).toBeGreaterThanOrEqual(2);
  });
});
