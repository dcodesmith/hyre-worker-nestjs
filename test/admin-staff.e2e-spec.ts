import { HttpStatus, type INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { STAFF } from "../src/modules/auth/auth.const";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import { DatabaseService } from "../src/modules/database/database.service";
import { TestDataFactory, uniqueEmail } from "./helpers";

describe("Admin staff E2E Tests", () => {
  let app: INestApplication;
  let databaseService: DatabaseService;
  let factory: TestDataFactory;
  let adminCookie: string;
  let userCookie: string;
  let staffCookie: string;

  const staffBody = (email: string) => ({
    name: "New Staff",
    email,
    phoneNumber: "+2348012345678",
  });

  async function persistedUser(email: string) {
    return databaseService.user.findUnique({
      where: { email },
      select: {
        id: true,
        name: true,
        email: true,
        phoneNumber: true,
        city: true,
        address: true,
        roles: { select: { name: true } },
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

    const adminAuth = await factory.createAuthenticatedAdmin(uniqueEmail("admin-staff-admin"));
    adminCookie = adminAuth.cookie;

    const userAuth = await factory.authenticateAndGetUser(uniqueEmail("admin-staff-user"), "user");
    userCookie = userAuth.cookie;

    const staffAuth = await factory.authenticateAndGetUser(
      uniqueEmail("admin-staff-staff"),
      "user",
    );
    await factory.assignRole(staffAuth.user.id, STAFF);
    staffCookie = staffAuth.cookie;
  });

  afterAll(async () => {
    await app.close();
  });

  it("POST /api/admin/staff requires authentication", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/admin/staff")
      .send(staffBody(uniqueEmail("admin-staff-anon")));

    expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
  });

  it("POST /api/admin/staff rejects an ordinary user", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/admin/staff")
      .set("Cookie", userCookie)
      .send(staffBody(uniqueEmail("admin-staff-user-denied")));

    expect(response.status).toBe(HttpStatus.FORBIDDEN);
  });

  it("POST /api/admin/staff rejects staff", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/admin/staff")
      .set("Cookie", staffCookie)
      .send(staffBody(uniqueEmail("admin-staff-staff-denied")));

    expect(response.status).toBe(HttpStatus.FORBIDDEN);
  });

  it("POST /api/admin/staff creates a staff member for an admin", async () => {
    const email = uniqueEmail("admin-staff-create");

    const response = await request(app.getHttpServer())
      .post("/api/admin/staff")
      .set("Cookie", adminCookie)
      .send({
        name: "  Ada Staff  ",
        email: `  ${email.toUpperCase()}  `,
        phoneNumber: "  +2348012345678  ",
      });

    expect(response.status).toBe(HttpStatus.CREATED);
    expect(response.body).toMatchObject({
      name: "Ada Staff",
      email,
      phoneNumber: "+2348012345678",
    });
    expect(response.body).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        createdAt: expect.any(String),
      }),
    );
    expect(response.body).not.toHaveProperty("roles");

    const persisted = await persistedUser(email);
    expect(persisted).toMatchObject({
      id: response.body.id,
      name: "Ada Staff",
      email,
      phoneNumber: "+2348012345678",
    });
    expect(persisted?.roles.map((role) => role.name)).toContain(STAFF);
  });

  it("POST /api/admin/staff promotes an existing user without overwriting profile fields", async () => {
    const email = uniqueEmail("admin-staff-existing");
    const existing = await factory.createUser({
      email,
      name: "Original Name",
    });
    await databaseService.user.update({
      where: { id: existing.id },
      data: {
        phoneNumber: "+2348011111111",
        city: "Lagos",
        address: "12 Marina",
      },
    });

    const first = await request(app.getHttpServer())
      .post("/api/admin/staff")
      .set("Cookie", adminCookie)
      .send({
        name: "Should Not Overwrite",
        email,
        phoneNumber: "+2348099999999",
      });

    expect(first.status).toBe(HttpStatus.CREATED);
    expect(first.body).toMatchObject({
      id: existing.id,
      name: "Original Name",
      email,
      phoneNumber: "+2348011111111",
    });

    const second = await request(app.getHttpServer())
      .post("/api/admin/staff")
      .set("Cookie", adminCookie)
      .send({
        name: "Still Should Not Overwrite",
        email,
        phoneNumber: "+2348000000000",
      });

    expect(second.status).toBe(HttpStatus.CREATED);
    expect(second.body).toMatchObject({
      id: existing.id,
      name: "Original Name",
      email,
      phoneNumber: "+2348011111111",
    });

    const persisted = await persistedUser(email);
    expect(persisted).toMatchObject({
      id: existing.id,
      name: "Original Name",
      email,
      phoneNumber: "+2348011111111",
      city: "Lagos",
      address: "12 Marina",
    });
    expect(persisted?.roles.map((role) => role.name)).toContain(STAFF);
  });

  it("POST /api/admin/staff rejects an invalid body", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/admin/staff")
      .set("Cookie", adminCookie)
      .send({
        name: "Ada",
        email: "not-an-email",
        phoneNumber: "+2348012345678",
      });

    expect(response.status).toBe(HttpStatus.BAD_REQUEST);
  });
});
