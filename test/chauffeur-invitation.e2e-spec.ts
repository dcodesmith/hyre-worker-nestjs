import { createHmac } from "node:crypto";
import { HttpStatus, type INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { ChauffeurApprovalStatus, ChauffeurVerificationStatus } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import { ChauffeurImageService } from "../src/modules/chauffeur/chauffeur-image.service";
import { DatabaseService } from "../src/modules/database/database.service";
import { EmailService } from "../src/modules/email/email.service";
import { PremblyService } from "../src/modules/prembly/prembly.service";
import { StorageService } from "../src/modules/storage/storage.service";
import { TestDataFactory, uniqueEmail } from "./helpers";

const twilioMocks = vi.hoisted(() => ({
  createVerification: vi.fn(),
  createVerificationCheck: vi.fn(),
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

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const PHONE = "+2348091111111";

function hash(value: string): string {
  return createHmac("sha256", process.env.HMAC_KEY ?? "")
    .update(value)
    .digest("hex");
}

function extractInviteToken(html: string): string {
  const match = html.match(/[?&]token=([^&"'<\s]+)/);
  if (!match?.[1]) {
    throw new Error(`Invite token missing from email HTML: ${html}`);
  }
  return decodeURIComponent(match[1]);
}

describe("Chauffeur invitation and verification E2E Tests", () => {
  let app: INestApplication;
  let databaseService: DatabaseService;
  let factory: TestDataFactory;
  let ownerCookie: string;
  let ownerId: string;
  let ownerCarId: string;
  let customerId: string;
  let clientIp = "203.0.113.40";
  let ipSequence = 40;
  const emailService = { sendEmail: vi.fn().mockResolvedValue({ id: "email-1" }) };

  function htmlSentTo(to: string): string {
    const html = [...emailService.sendEmail.mock.calls]
      .reverse()
      .map(([payload]) => payload as { to?: string; html?: string })
      .find((payload) => payload.to === to)?.html;
    if (!html) {
      throw new Error(`No email sent to ${to}`);
    }
    return html;
  }

  const storageService = {
    uploadBuffer: vi.fn().mockResolvedValue("https://cdn.tripdly.test/chauffeur.jpg"),
    deleteObjectByKey: vi.fn().mockResolvedValue(undefined),
  };
  const premblyService = {
    verifyNin: vi.fn(),
    verifyDriversLicense: vi.fn(),
    verifyFaceLiveness: vi.fn(),
    compareFaces: vi.fn(),
  };

  function http(method: "get" | "post" | "put" | "patch", path: string) {
    return request(app.getHttpServer())[method](path).set("X-Forwarded-For", clientIp);
  }

  async function readyOwner(
    emailPrefix: string,
    extras: { isOwnerDriver?: boolean; chauffeurApprovalStatus?: ChauffeurApprovalStatus } = {},
  ) {
    const auth = await factory.authenticateAndGetUser(
      uniqueEmail(emailPrefix),
      "fleetOwner",
      "web",
    );
    await databaseService.user.update({
      where: { id: auth.user.id },
      data: {
        emailVerified: true,
        phoneNumber: "+2348012345678",
        phoneVerifiedAt: new Date(),
        hasOnboarded: true,
        fleetOwnerStatus: "APPROVED",
        isOwnerDriver: extras.isOwnerDriver ?? false,
        chauffeurApprovalStatus: extras.chauffeurApprovalStatus ?? null,
        chauffeurDisabledAt: null,
      },
    });
    return { cookie: auth.cookie, id: auth.user.id };
  }

  async function invite(
    cookie: string,
    extras: { email?: string; idempotencyKey?: string; name?: string } = {},
  ) {
    const email = extras.email ?? uniqueEmail("chauffeur-invitee");
    const response = await http("post", "/api/fleet-owner/chauffeur-invitations")
      .set("Cookie", cookie)
      .set("Idempotency-Key", extras.idempotencyKey ?? `invite-${Date.now()}-${Math.random()}`)
      .send({
        name: extras.name ?? "Ada Driver",
        email,
        phoneNumber: PHONE,
      });
    if (response.status >= 500) {
      throw new Error(
        `chauffeur invitation failed: status ${response.status}, body: ${JSON.stringify(response.body)}`,
      );
    }
    return { response, email };
  }

  async function exchange(token: string) {
    return http("post", "/api/chauffeur-onboarding/invitation-exchanges").send({ token });
  }

  function onboarding(method: "get" | "post" | "put", path: string, sessionToken: string) {
    return http(method, `/api/chauffeur-onboarding${path}`).set(
      "Authorization",
      `Bearer ${sessionToken}`,
    );
  }

  async function completeOnboarding(
    session: string,
    extras: { nin?: string; license?: string; prefix?: string } = {},
  ) {
    await onboarding("put", "/consent", session).send({
      termsAccepted: true,
      privacyAccepted: true,
    });
    await onboarding("post", "/phone-verifications", session);
    await onboarding("post", "/phone-verification-checks", session).send({ code: "123456" });
    const nin = await onboarding("post", "/nin-verifications", session)
      .set("Idempotency-Key", `${extras.prefix ?? "nin"}-${Date.now()}-${Math.random()}`)
      .send({ nin: extras.nin ?? "12345678901" });
    const driving = await onboarding("post", "/driving-verifications", session)
      .set("Idempotency-Key", `${extras.prefix ?? "drive"}-${Date.now()}-${Math.random()}`)
      .field("driversLicenseNumber", extras.license ?? "ABC12345")
      .attach("selfie", JPEG, { filename: "selfie.jpg", contentType: "image/jpeg" });
    return { nin, driving };
  }

  async function seedApprovedChauffeur(fleetOwnerId: string, emailPrefix: string) {
    const chauffeur = await factory.createUser({
      email: uniqueEmail(emailPrefix),
      name: "Hired Driver",
      fleetOwnerId,
      chauffeurApprovalStatus: ChauffeurApprovalStatus.APPROVED,
      chauffeurDisabledAt: null,
      roles: ["user"],
    });
    await databaseService.chauffeurVerification.create({
      data: {
        fleetOwnerId,
        chauffeurId: chauffeur.id,
        name: "Hired Driver",
        email: chauffeur.email,
        phoneNumber: PHONE,
        invitationIdempotencyKey: hash(`seed-${chauffeur.id}`),
        invitationRequestHash: hash(chauffeur.email),
        inviteTokenHash: hash(`seed-token-${chauffeur.id}`),
        inviteExpiresAt: new Date(Date.now() + 86_400_000),
        inviteAcceptedAt: new Date(),
        status: ChauffeurVerificationStatus.APPROVED,
      },
    });
    return chauffeur;
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuthEmailService)
      .useValue({ sendOTPEmail: async () => undefined })
      .overrideProvider(EmailService)
      .useValue(emailService)
      .overrideProvider(PremblyService)
      .useValue(premblyService)
      .overrideProvider(StorageService)
      .useValue(storageService)
      .overrideProvider(ChauffeurImageService)
      .useValue({ processSelfie: vi.fn().mockResolvedValue(Buffer.from("processed-selfie")) })
      .compile();

    app = moduleFixture.createNestApplication({ logger: false });
    await app.init();

    databaseService = app.get(DatabaseService);
    factory = new TestDataFactory(databaseService, app);

    const owner = await readyOwner("chauffeur-e2e-owner");
    ownerCookie = owner.cookie;
    ownerId = owner.id;
    ownerCarId = (await factory.createCar(ownerId, { registrationNumber: "E2E-CHAUF-001" })).id;
    customerId = (await factory.createUser({ email: uniqueEmail("chauffeur-e2e-customer") })).id;
  });

  beforeEach(async () => {
    await factory.clearRateLimits();
    emailService.sendEmail.mockClear();
    clientIp = `203.0.113.${ipSequence++}`;
    twilioMocks.createVerification.mockReset();
    twilioMocks.createVerificationCheck.mockReset();
    twilioMocks.createVerification.mockResolvedValue({ status: "pending" });
    twilioMocks.createVerificationCheck.mockResolvedValue({ status: "approved" });
    premblyService.verifyNin.mockReset();
    premblyService.verifyDriversLicense.mockReset();
    premblyService.verifyFaceLiveness.mockReset();
    premblyService.compareFaces.mockReset();
    premblyService.verifyNin.mockResolvedValue({
      firstName: "ADA",
      middleName: null,
      lastName: "LOVELACE",
      reference: "nin-ref",
    });
    premblyService.verifyDriversLicense.mockResolvedValue({
      licenseNumber: "ABC12345",
      firstName: "ADA",
      lastName: "LOVELACE",
      middleName: null,
      dateOfBirth: new Date(Date.UTC(1990, 0, 1)),
      expiresAt: new Date(Date.UTC(2099, 11, 31)),
      officialPhoto: "official-photo",
      reference: "lic-ref",
    });
    premblyService.verifyFaceLiveness.mockResolvedValue({
      confidence: 0.93,
      reference: "live-ref",
    });
    premblyService.compareFaces.mockResolvedValue({ confidence: 91 });
    storageService.uploadBuffer.mockClear();
  });

  afterAll(async () => {
    await app.close();
  });

  it("lets a verified non-owner-driver invite and keeps the raw token out of the API and database", async () => {
    const { response, email } = await invite(ownerCookie);

    expect(response.status).toBe(HttpStatus.CREATED);
    expect(response.body).toMatchObject({
      name: "Ada Driver",
      email,
      phoneNumber: PHONE,
      status: "INVITED",
      chauffeurId: null,
    });
    expect(JSON.stringify(response.body)).not.toMatch(/token=/);
    expect(response.body.inviteToken).toBeUndefined();
    expect(response.body.sessionToken).toBeUndefined();

    const token = extractInviteToken(htmlSentTo(email));

    const stored = await databaseService.chauffeurVerification.findFirst({
      where: { fleetOwnerId: ownerId, email },
    });
    expect(stored).toBeTruthy();
    expect(stored?.inviteTokenHash).toBe(hash(token));
    expect(stored?.inviteTokenHash).not.toBe(token);
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it("rejects invitations from an owner-driver", async () => {
    const ownerDriver = await readyOwner("chauffeur-e2e-owner-driver", {
      isOwnerDriver: true,
      chauffeurApprovalStatus: ChauffeurApprovalStatus.APPROVED,
    });
    const { response, email } = await invite(ownerDriver.cookie);

    expect(response.status).toBe(HttpStatus.CONFLICT);
    expect(response.body.errorCode).toBe("CHAUFFEUR_INVITATION_NOT_ALLOWED");
    expect(emailService.sendEmail.mock.calls.some(([{ to }]) => to === email)).toBe(false);
  });

  it("exchanges an invite token once and rejects reuse", async () => {
    const { email } = await invite(ownerCookie);
    const token = extractInviteToken(htmlSentTo(email));

    const first = await exchange(token);
    expect(first.status).toBe(HttpStatus.CREATED);
    expect(first.body.sessionToken).toEqual(expect.any(String));
    expect(first.body.onboarding).toMatchObject({
      email,
      status: "INVITED",
      steps: { consent: false, phone: false, nin: false, driving: false },
    });
    expect(first.body.onboarding.phoneNumber).toBe("**********1111");

    const stored = await databaseService.chauffeurVerification.findFirst({
      where: { fleetOwnerId: ownerId, email },
    });
    expect(stored?.inviteAcceptedAt).toBeTruthy();
    expect(stored?.sessionTokenHash).toBe(hash(first.body.sessionToken));
    expect(stored?.sessionTokenHash).not.toBe(first.body.sessionToken);

    const second = await exchange(token);
    expect(second.status).toBe(HttpStatus.GONE);
    expect(second.body.errorCode).toBe("CHAUFFEUR_INVITATION_INVALID");
  });

  it("enforces consent before phone verification", async () => {
    const { email } = await invite(ownerCookie);
    const token = extractInviteToken(htmlSentTo(email));
    const session = (await exchange(token)).body.sessionToken as string;

    const tooEarly = await onboarding("post", "/phone-verifications", session);
    expect(tooEarly.status).toBe(HttpStatus.CONFLICT);
    expect(tooEarly.body.errorCode).toBe("CHAUFFEUR_VERIFICATION_STEP_INCOMPLETE");

    const consent = await onboarding("put", "/consent", session).send({
      termsAccepted: true,
      privacyAccepted: true,
    });
    expect(consent.status).toBe(HttpStatus.OK);
    expect(consent.body.steps.consent).toBe(true);

    const phone = await onboarding("post", "/phone-verifications", session);
    expect(phone.status).toBe(HttpStatus.CREATED);
    expect(phone.body.status).toBe("PENDING");
  });

  it("isolates onboarding sessions so one invitee cannot read another", async () => {
    const first = await invite(ownerCookie, { name: "First Driver" });
    const firstToken = extractInviteToken(htmlSentTo(first.email));
    const second = await invite(ownerCookie, { name: "Second Driver" });
    const secondToken = extractInviteToken(htmlSentTo(second.email));

    const firstSession = (await exchange(firstToken)).body.sessionToken as string;
    const secondSession = (await exchange(secondToken)).body.sessionToken as string;

    await onboarding("put", "/consent", firstSession).send({
      termsAccepted: true,
      privacyAccepted: true,
    });

    const firstState = await onboarding("get", "", firstSession);
    const secondState = await onboarding("get", "", secondSession);
    expect(firstState.body.name).toBe("First Driver");
    expect(firstState.body.steps.consent).toBe(true);
    expect(secondState.body.name).toBe("Second Driver");
    expect(secondState.body.steps.consent).toBe(false);

    const unauthenticated = await http("get", "/api/chauffeur-onboarding");
    expect(unauthenticated.status).toBe(HttpStatus.UNAUTHORIZED);
  });

  it("lists invited chauffeurs and deactivates an approved hire", async () => {
    const chauffeur = await seedApprovedChauffeur(ownerId, "chauffeur-e2e-list");

    const listed = await http("get", "/api/fleet-owner/chauffeurs").set("Cookie", ownerCookie);
    expect(listed.status).toBe(HttpStatus.OK);
    expect(
      listed.body.items.some(
        (item: { chauffeurId: string | null }) => item.chauffeurId === chauffeur.id,
      ),
    ).toBe(true);
    expect(listed.body.complianceRequirements).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "LASDRI", required: false })]),
    );

    const deactivated = await http("patch", `/api/fleet-owner/chauffeurs/${chauffeur.id}`)
      .set("Cookie", ownerCookie)
      .send({ isActive: false });
    expect(deactivated.status).toBe(HttpStatus.OK);
    expect(deactivated.body.isActive).toBe(false);

    const stored = await databaseService.user.findUnique({
      where: { id: chauffeur.id },
      select: { chauffeurDisabledAt: true },
    });
    expect(stored?.chauffeurDisabledAt).toBeTruthy();
  });

  it("rejects assigning a disabled or overlapping chauffeur and allows owner-driver self-assignment", async () => {
    const startDate = new Date("2031-03-01T08:00:00.000Z");
    const endDate = new Date("2031-03-01T20:00:00.000Z");
    const booking = await factory.createBooking(customerId, ownerCarId, {
      status: "CONFIRMED",
      paymentStatus: "PAID",
      startDate,
      endDate,
    });
    const chauffeur = await seedApprovedChauffeur(ownerId, "chauffeur-e2e-assign");

    await databaseService.user.update({
      where: { id: chauffeur.id },
      data: { chauffeurDisabledAt: new Date() },
    });
    const disabled = await http("patch", `/api/fleet-owner/bookings/${booking.id}/chauffeur`)
      .set("Cookie", ownerCookie)
      .send({ chauffeurId: chauffeur.id });
    expect(disabled.status).toBe(HttpStatus.NOT_FOUND);

    await databaseService.user.update({
      where: { id: chauffeur.id },
      data: { chauffeurDisabledAt: null },
    });
    const assigned = await http("patch", `/api/fleet-owner/bookings/${booking.id}/chauffeur`)
      .set("Cookie", ownerCookie)
      .send({ chauffeurId: chauffeur.id });
    expect(assigned.status).toBe(HttpStatus.OK);

    const secondCar = await factory.createCar(ownerId, { registrationNumber: "E2E-CHAUF-002" });
    const overlapping = await factory.createBooking(customerId, secondCar.id, {
      status: "CONFIRMED",
      paymentStatus: "PAID",
      startDate: new Date("2031-03-01T12:00:00.000Z"),
      endDate: new Date("2031-03-01T18:00:00.000Z"),
    });
    const overlap = await http("patch", `/api/fleet-owner/bookings/${overlapping.id}/chauffeur`)
      .set("Cookie", ownerCookie)
      .send({ chauffeurId: chauffeur.id });
    expect(overlap.status).toBe(HttpStatus.NOT_FOUND);

    const ownerDriver = await readyOwner("chauffeur-e2e-self-assign", {
      isOwnerDriver: true,
      chauffeurApprovalStatus: ChauffeurApprovalStatus.APPROVED,
    });
    const ownerCar = await factory.createCar(ownerDriver.id, {
      registrationNumber: "E2E-CHAUF-SELF",
    });
    const ownerBooking = await factory.createBooking(customerId, ownerCar.id, {
      status: "CONFIRMED",
      paymentStatus: "PAID",
    });
    const selfAssign = await http("patch", `/api/fleet-owner/bookings/${ownerBooking.id}/chauffeur`)
      .set("Cookie", ownerDriver.cookie)
      .send({ chauffeurId: ownerDriver.id });
    expect(selfAssign.status).toBe(HttpStatus.OK);
    expect(selfAssign.body.chauffeur?.id ?? selfAssign.body.chauffeurId).toBe(ownerDriver.id);
  });

  it("rejects invalid invite payloads and reused idempotency keys", async () => {
    const invalid = await http("post", "/api/fleet-owner/chauffeur-invitations")
      .set("Cookie", ownerCookie)
      .set("Idempotency-Key", "valid-key")
      .send({ name: "A", email: "not-email", phoneNumber: "0801" });
    expect(invalid.status).toBe(HttpStatus.BAD_REQUEST);

    const missingKey = await http("post", "/api/fleet-owner/chauffeur-invitations")
      .set("Cookie", ownerCookie)
      .send({ name: "Ada Driver", email: uniqueEmail("no-key"), phoneNumber: PHONE });
    expect(missingKey.status).toBe(HttpStatus.BAD_REQUEST);

    const email = uniqueEmail("idempotent-invite");
    const first = await invite(ownerCookie, { email, idempotencyKey: "same-invite-key" });
    expect(first.response.status).toBe(HttpStatus.CREATED);
    const replay = await invite(ownerCookie, { email, idempotencyKey: "same-invite-key" });
    expect(replay.response.status).toBe(HttpStatus.CREATED);
    expect(replay.response.body.id).toBe(first.response.body.id);

    const reused = await invite(ownerCookie, {
      email: uniqueEmail("idempotent-other"),
      idempotencyKey: "same-invite-key",
    });
    expect(reused.response.status).toBe(HttpStatus.CONFLICT);
    expect(reused.response.body.errorCode).toBe("CHAUFFEUR_IDEMPOTENCY_KEY_REUSED");
  });

  it("creates a new approved User after mocked NIN, licence, liveness, and face verification", async () => {
    const email = uniqueEmail("chauffeur-e2e-create");
    await invite(ownerCookie, { email, name: "Ada Lovelace" });
    const token = extractInviteToken(htmlSentTo(email));
    const session = (await exchange(token)).body.sessionToken as string;

    await onboarding("put", "/consent", session).send({
      termsAccepted: true,
      privacyAccepted: true,
    });
    await onboarding("post", "/phone-verifications", session);
    await onboarding("post", "/phone-verification-checks", session).send({ code: "123456" });
    const nin = await onboarding("post", "/nin-verifications", session)
      .set("Idempotency-Key", `nin-${Date.now()}`)
      .send({ nin: "12345678901" });
    expect(nin.status).toBe(HttpStatus.CREATED);
    expect(nin.body.steps.nin).toBe(true);

    const driving = await onboarding("post", "/driving-verifications", session)
      .set("Idempotency-Key", `drive-${Date.now()}`)
      .field("driversLicenseNumber", "ABC12345")
      .attach("selfie", JPEG, { filename: "selfie.jpg", contentType: "image/jpeg" });
    expect(driving.status).toBe(HttpStatus.CREATED);
    expect(driving.body.status).toBe("APPROVED");
    expect(driving.body.steps.driving).toBe(true);

    const user = await databaseService.user.findUnique({
      where: { email },
      select: {
        id: true,
        fleetOwnerId: true,
        chauffeurApprovalStatus: true,
        hasOnboarded: true,
        name: true,
        image: true,
      },
    });
    expect(user).toMatchObject({
      fleetOwnerId: ownerId,
      chauffeurApprovalStatus: "APPROVED",
      hasOnboarded: true,
      name: "ADA LOVELACE",
      image: null,
    });
    const verification = await databaseService.chauffeurVerification.findFirst({
      where: { email },
      select: { id: true, selfieObjectKey: true },
    });
    expect(verification?.selfieObjectKey).toBeTruthy();
    expect(verification?.selfieObjectKey).not.toEqual(user?.image);
    expect(storageService.uploadBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      `${ownerId}/chauffeurs/${verification?.id}/documents/selfie.jpg`,
      "image/jpeg",
    );

    const replayNin = await onboarding("post", "/nin-verifications", session)
      .set("Idempotency-Key", `nin-replay-${Date.now()}`)
      .send({ nin: "99999999999" });
    expect(replayNin.status).toBe(HttpStatus.CREATED);
    expect(replayNin.body.status).toBe("APPROVED");
    expect(premblyService.verifyNin).toHaveBeenCalledTimes(1);

    await databaseService.user.update({
      where: { id: user?.id },
      data: { chauffeurDisabledAt: new Date() },
    });
    const replayDriving = await onboarding("post", "/driving-verifications", session)
      .set("Idempotency-Key", `drive-replay-${Date.now()}`)
      .field("driversLicenseNumber", "ZZZ99999")
      .attach("selfie", JPEG, { filename: "selfie.jpg", contentType: "image/jpeg" });
    expect(replayDriving.status).toBe(HttpStatus.CREATED);
    expect(replayDriving.body.status).toBe("APPROVED");
    expect(premblyService.verifyDriversLicense).toHaveBeenCalledTimes(1);
    expect(
      await databaseService.user.findUnique({
        where: { id: user?.id },
        select: { chauffeurDisabledAt: true, image: true },
      }),
    ).toMatchObject({ chauffeurDisabledAt: expect.any(Date), image: null });
  });

  it("links an existing eligible User instead of creating a duplicate", async () => {
    const email = uniqueEmail("chauffeur-e2e-link");
    const existing = await factory.createUser({
      email,
      name: "Existing Driver",
      roles: ["user"],
    });
    await invite(ownerCookie, { email, name: "Ada Lovelace" });
    const token = extractInviteToken(htmlSentTo(email));
    const session = (await exchange(token)).body.sessionToken as string;

    await onboarding("put", "/consent", session).send({
      termsAccepted: true,
      privacyAccepted: true,
    });
    await onboarding("post", "/phone-verifications", session);
    await onboarding("post", "/phone-verification-checks", session).send({ code: "123456" });
    await onboarding("post", "/nin-verifications", session)
      .set("Idempotency-Key", `nin-link-${Date.now()}`)
      .send({ nin: "23456789012" });
    const driving = await onboarding("post", "/driving-verifications", session)
      .set("Idempotency-Key", `drive-link-${Date.now()}`)
      .field("driversLicenseNumber", "LINK12345")
      .attach("selfie", JPEG, { filename: "selfie.jpg", contentType: "image/jpeg" });

    expect(driving.status).toBe(HttpStatus.CREATED);
    const linked = await databaseService.user.findUnique({
      where: { email },
      select: { id: true, fleetOwnerId: true, chauffeurApprovalStatus: true },
    });
    expect(linked?.id).toBe(existing.id);
    expect(linked).toMatchObject({
      fleetOwnerId: ownerId,
      chauffeurApprovalStatus: "APPROVED",
    });
    expect(await databaseService.user.count({ where: { email } })).toBe(1);
  });

  it("allows a new invite after the previous unaccepted invite expires", async () => {
    const email = uniqueEmail("chauffeur-e2e-reinvite");
    const first = await invite(ownerCookie, { email, idempotencyKey: "expired-invite-1" });
    expect(first.response.status).toBe(HttpStatus.CREATED);

    await databaseService.chauffeurVerification.update({
      where: { id: first.response.body.id },
      data: { inviteExpiresAt: new Date(Date.now() - 1000) },
    });

    const second = await invite(ownerCookie, { email, idempotencyKey: "expired-invite-2" });
    expect(second.response.status).toBe(HttpStatus.CREATED);
    expect(second.response.body.id).not.toBe(first.response.body.id);
  });

  it("rejects a second approved chauffeur that reuses the same NIN", async () => {
    const firstEmail = uniqueEmail("chauffeur-e2e-nin-a");
    await invite(ownerCookie, { email: firstEmail, name: "Ada Lovelace" });
    const firstToken = extractInviteToken(htmlSentTo(firstEmail));
    const first = await completeOnboarding(
      (await exchange(firstToken)).body.sessionToken as string,
      {
        prefix: "uniq-a",
        nin: "34567890123",
        license: "UNIQ11111",
      },
    );
    expect(first.driving.status).toBe(HttpStatus.CREATED);

    const secondEmail = uniqueEmail("chauffeur-e2e-nin-b");
    await invite(ownerCookie, { email: secondEmail, name: "Ada Lovelace" });
    const secondToken = extractInviteToken(htmlSentTo(secondEmail));
    const second = await completeOnboarding(
      (await exchange(secondToken)).body.sessionToken as string,
      { prefix: "uniq-b", nin: "34567890123", license: "UNIQ22222" },
    );
    expect(second.nin.status).toBe(HttpStatus.CREATED);
    expect(second.driving.status).toBe(HttpStatus.CONFLICT);
    expect(second.driving.body.errorCode).toBe("CHAUFFEUR_ACCOUNT_CONFLICT");
  });

  it("enforces overlapping chauffeur reservations at the database boundary", async () => {
    const chauffeur = await seedApprovedChauffeur(ownerId, "chauffeur-e2e-overlap-db");
    const startDate = new Date("2032-06-01T08:00:00.000Z");
    const endDate = new Date("2032-06-01T20:00:00.000Z");
    const secondCar = await factory.createCar(ownerId, { registrationNumber: "E2E-CHAUF-OVLP" });

    await factory.createBooking(customerId, ownerCarId, {
      status: "CONFIRMED",
      paymentStatus: "PAID",
      chauffeurId: chauffeur.id,
      startDate,
      endDate,
    });

    await expect(
      factory.createBooking(customerId, secondCar.id, {
        status: "CONFIRMED",
        paymentStatus: "PAID",
        chauffeurId: chauffeur.id,
        startDate: new Date("2032-06-01T12:00:00.000Z"),
        endDate: new Date("2032-06-01T18:00:00.000Z"),
      }),
    ).rejects.toThrow();
  });
});
