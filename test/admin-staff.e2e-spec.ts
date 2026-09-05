import { HttpStatus, type INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { STAFF } from "../src/modules/auth/auth.const";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import { DatabaseService } from "../src/modules/database/database.service";
import { UsersErrorCode } from "../src/modules/users/users.error";
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
        staffRevokedAt: true,
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
    expect(persisted?.staffRevokedAt).toBeNull();
  });

  it("POST /api/admin/staff handles concurrent creation of the same email", async () => {
    const email = uniqueEmail("admin-staff-concurrent-create");

    const responses = await Promise.all([
      request(app.getHttpServer())
        .post("/api/admin/staff")
        .set("Cookie", adminCookie)
        .send(staffBody(email)),
      request(app.getHttpServer())
        .post("/api/admin/staff")
        .set("Cookie", adminCookie)
        .send(staffBody(email)),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([HttpStatus.CREATED, HttpStatus.CREATED]);
    expect(responses[0].body.id).toBe(responses[1].body.id);
    expect(await databaseService.user.count({ where: { email } })).toBe(1);
    expect((await persistedUser(email))?.roles.map(({ name }) => name)).toContain(STAFF);
  });

  it("POST /api/admin/staff promotes an existing user without overwriting profile fields", async () => {
    const email = uniqueEmail("admin-staff-existing");
    const existing = await factory.createUser({
      email,
      name: "Original Name",
      roles: ["user"],
    });
    await databaseService.user.update({
      where: { id: existing.id },
      data: {
        phoneNumber: "+2348011111111",
        city: "Lagos",
        address: "12 Marina",
        staffRevokedAt: new Date("2026-02-01T00:00:00.000Z"),
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
    expect(persisted?.roles.map((role) => role.name)).toEqual(
      expect.arrayContaining(["user", STAFF]),
    );
    expect(persisted?.staffRevokedAt).toBeNull();
  });

  it.each(["admin", "fleetOwner", "chauffeur"])(
    "POST /api/admin/staff rejects an existing %s",
    async (role) => {
      const email = uniqueEmail(`admin-staff-${role}`);
      const existing = await factory.createUser({ email, roles: [role] });

      const response = await request(app.getHttpServer())
        .post("/api/admin/staff")
        .set("Cookie", adminCookie)
        .send(staffBody(email));

      expect(response.status).toBe(HttpStatus.CONFLICT);
      expect(response.body).toMatchObject({
        type: UsersErrorCode.USERS_STAFF_ROLE_CONFLICT,
        status: HttpStatus.CONFLICT,
        errorCode: UsersErrorCode.USERS_STAFF_ROLE_CONFLICT,
      });

      const persisted = await persistedUser(email);
      expect(persisted?.id).toBe(existing.id);
      expect(persisted?.roles.map(({ name }) => name)).toEqual([role]);
    },
  );

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

  it.each([
    { method: "get" as const, path: () => "/api/admin/staff" },
    { method: "post" as const, path: (id: string) => `/api/admin/staff/${id}/revoke` },
    { method: "post" as const, path: (id: string) => `/api/admin/staff/${id}/reinstate` },
  ])("$method staff lifecycle route is admin-only", async ({ method, path }) => {
    const target = await factory.createUser({
      email: uniqueEmail("admin-staff-auth"),
      roles: ["user", STAFF],
    });
    const url = path(target.id);

    const anonymous = await request(app.getHttpServer())[method](url);
    expect(anonymous.status).toBe(HttpStatus.UNAUTHORIZED);

    const asUser = await request(app.getHttpServer())[method](url).set("Cookie", userCookie);
    expect(asUser.status).toBe(HttpStatus.FORBIDDEN);

    const asStaff = await request(app.getHttpServer())[method](url).set("Cookie", staffCookie);
    expect(asStaff.status).toBe(HttpStatus.FORBIDDEN);
  });

  it("GET /api/admin/staff lists active and revoked staff with pagination", async () => {
    const activeEmail = uniqueEmail("admin-staff-list-active");
    const revokedEmail = uniqueEmail("admin-staff-list-revoked");
    const otherEmail = uniqueEmail("admin-staff-list-other");
    const [active, revoked] = await Promise.all([
      factory.createUser({ email: activeEmail, name: "Active Staff", roles: ["user", STAFF] }),
      factory.createUser({ email: revokedEmail, name: "Revoked Staff", roles: ["user"] }),
      factory.createUser({ email: otherEmail, name: "Ordinary User", roles: ["user"] }),
    ]);
    await databaseService.user.update({
      where: { id: revoked.id },
      data: { staffRevokedAt: new Date("2026-03-01T00:00:00.000Z") },
    });

    const all = await request(app.getHttpServer())
      .get("/api/admin/staff")
      .set("Cookie", adminCookie);
    expect(all.status).toBe(HttpStatus.OK);
    expect(all.body.staff.map((member: { id: string }) => member.id)).toEqual(
      expect.arrayContaining([active.id, revoked.id]),
    );
    expect(all.body.staff.map((member: { id: string }) => member.id)).not.toContain(
      (await persistedUser(otherEmail))?.id,
    );
    expect(all.body.meta).toEqual(
      expect.objectContaining({
        page: 1,
        limit: 20,
        total: expect.any(Number),
        totalPages: expect.any(Number),
      }),
    );

    const activeOnly = await request(app.getHttpServer())
      .get("/api/admin/staff?status=active")
      .set("Cookie", adminCookie);
    expect(activeOnly.body.staff.map((member: { id: string }) => member.id)).toContain(active.id);
    expect(activeOnly.body.staff.map((member: { id: string }) => member.id)).not.toContain(
      revoked.id,
    );
    expect(
      activeOnly.body.staff.every((member: { status: string }) => member.status === "active"),
    ).toBe(true);

    const revokedOnly = await request(app.getHttpServer())
      .get("/api/admin/staff?status=revoked")
      .set("Cookie", adminCookie);
    expect(revokedOnly.body.staff.map((member: { id: string }) => member.id)).toContain(revoked.id);
    expect(revokedOnly.body.staff.map((member: { id: string }) => member.id)).not.toContain(
      active.id,
    );

    const page = await request(app.getHttpServer())
      .get("/api/admin/staff?page=1&limit=1")
      .set("Cookie", adminCookie);
    expect(page.body.staff).toHaveLength(1);
    expect(page.body.meta).toMatchObject({ page: 1, limit: 1 });
    expect(page.body.meta.totalPages).toBe(Math.ceil(page.body.meta.total / 1));
  });

  it("rejects invalid list query values and staff ids", async () => {
    const invalidStatus = await request(app.getHttpServer())
      .get("/api/admin/staff?status=pending")
      .set("Cookie", adminCookie);
    expect(invalidStatus.status).toBe(HttpStatus.BAD_REQUEST);

    const invalidPage = await request(app.getHttpServer())
      .get("/api/admin/staff?page=0")
      .set("Cookie", adminCookie);
    expect(invalidPage.status).toBe(HttpStatus.BAD_REQUEST);

    const invalidLimit = await request(app.getHttpServer())
      .get("/api/admin/staff?limit=101")
      .set("Cookie", adminCookie);
    expect(invalidLimit.status).toBe(HttpStatus.BAD_REQUEST);

    const invalidId = await request(app.getHttpServer())
      .post("/api/admin/staff/not-a-cuid/revoke")
      .set("Cookie", adminCookie);
    expect(invalidId.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it("revokes and reinstates staff access", async () => {
    const email = uniqueEmail("admin-staff-lifecycle");
    const created = await request(app.getHttpServer())
      .post("/api/admin/staff")
      .set("Cookie", adminCookie)
      .send(staffBody(email));
    expect(created.status).toBe(HttpStatus.CREATED);

    const revoked = await request(app.getHttpServer())
      .post(`/api/admin/staff/${created.body.id}/revoke`)
      .set("Cookie", adminCookie);
    expect(revoked.status).toBe(HttpStatus.CREATED);
    expect(revoked.body).toMatchObject({
      id: created.body.id,
      status: "revoked",
    });
    expect(revoked.body.revokedAt).toEqual(expect.any(String));
    expect(revoked.body).not.toHaveProperty("roles");

    const afterRevoke = await persistedUser(email);
    expect(afterRevoke?.roles.map(({ name }) => name)).not.toContain(STAFF);
    expect(afterRevoke?.staffRevokedAt).toBeTruthy();

    const revokedAgain = await request(app.getHttpServer())
      .post(`/api/admin/staff/${created.body.id}/revoke`)
      .set("Cookie", adminCookie);
    expect(revokedAgain.status).toBe(HttpStatus.CREATED);
    expect(revokedAgain.body.revokedAt).toBe(revoked.body.revokedAt);

    const reinstated = await request(app.getHttpServer())
      .post(`/api/admin/staff/${created.body.id}/reinstate`)
      .set("Cookie", adminCookie);
    expect(reinstated.status).toBe(HttpStatus.CREATED);
    expect(reinstated.body).toMatchObject({
      id: created.body.id,
      status: "active",
      revokedAt: null,
    });

    const afterReinstate = await persistedUser(email);
    expect(afterReinstate?.roles.map(({ name }) => name)).toContain(STAFF);
    expect(afterReinstate?.staffRevokedAt).toBeNull();

    const reinstatedAgain = await request(app.getHttpServer())
      .post(`/api/admin/staff/${created.body.id}/reinstate`)
      .set("Cookie", adminCookie);
    expect(reinstatedAgain.status).toBe(HttpStatus.CREATED);
    expect(reinstatedAgain.body).toMatchObject({ status: "active", revokedAt: null });
  });

  it("returns 404 when revoking or reinstating a never-staff user", async () => {
    const neverStaff = await factory.createUser({
      email: uniqueEmail("admin-staff-never"),
      roles: ["user"],
    });

    const revoke = await request(app.getHttpServer())
      .post(`/api/admin/staff/${neverStaff.id}/revoke`)
      .set("Cookie", adminCookie);
    expect(revoke.status).toBe(HttpStatus.NOT_FOUND);
    expect(revoke.body).toMatchObject({
      type: UsersErrorCode.USERS_STAFF_NOT_FOUND,
      errorCode: UsersErrorCode.USERS_STAFF_NOT_FOUND,
    });

    const reinstate = await request(app.getHttpServer())
      .post(`/api/admin/staff/${neverStaff.id}/reinstate`)
      .set("Cookie", adminCookie);
    expect(reinstate.status).toBe(HttpStatus.NOT_FOUND);
  });

  it("returns 409 when reinstating a user with an incompatible role", async () => {
    const existing = await factory.createUser({
      email: uniqueEmail("admin-staff-reinstate-conflict"),
      roles: [FLEET_OWNER],
    });
    await databaseService.user.update({
      where: { id: existing.id },
      data: { staffRevokedAt: new Date("2026-03-01T00:00:00.000Z") },
    });

    const response = await request(app.getHttpServer())
      .post(`/api/admin/staff/${existing.id}/reinstate`)
      .set("Cookie", adminCookie);

    expect(response.status).toBe(HttpStatus.CONFLICT);
    expect(response.body).toMatchObject({
      type: UsersErrorCode.USERS_STAFF_ROLE_CONFLICT,
      errorCode: UsersErrorCode.USERS_STAFF_ROLE_CONFLICT,
    });
    const persisted = await persistedUser(existing.email);
    expect(persisted?.roles.map(({ name }) => name)).toEqual([FLEET_OWNER]);
    expect(persisted?.staffRevokedAt).toBeTruthy();
  });

  it("never persists both staff and fleetOwner under concurrent assignment", async () => {
    const email = uniqueEmail("admin-staff-race");
    const existing = await factory.createUser({ email, roles: ["user"] });
    const authService = app.get(AuthService);

    const [staffRes, fleetOwnerResult] = await Promise.all([
      request(app.getHttpServer())
        .post("/api/admin/staff")
        .set("Cookie", adminCookie)
        .send(staffBody(email)),
      authService.ensureUserHasRole(existing.id, FLEET_OWNER).then(
        () => "assigned" as const,
        () => "rejected" as const,
      ),
    ]);

    expect([HttpStatus.CREATED, HttpStatus.CONFLICT]).toContain(staffRes.status);
    expect(staffRes.status === HttpStatus.CREATED || fleetOwnerResult === "assigned").toBe(true);

    const persisted = await persistedUser(email);
    const roles = persisted?.roles.map(({ name }) => name) ?? [];
    expect(roles.includes(STAFF) && roles.includes(FLEET_OWNER)).toBe(false);
  });
});
