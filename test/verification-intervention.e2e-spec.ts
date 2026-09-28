import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { HttpStatus, type INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import {
  AccountVerificationStatus,
  ChauffeurVerificationStatus,
  DocumentStatus,
  DocumentType,
  FleetOwnerAccountType,
  NameMatchStatus,
  VerificationDecisionStatus,
  VerificationInterventionKind,
  VerificationInterventionStatus,
} from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import { DatabaseService } from "../src/modules/database/database.service";
import { TestDataFactory, uniqueEmail } from "./helpers";

const LICENSE_NUMBER = "ABC12345DE67";
const SECRET_PAYLOAD = "PLAINTEXT-LICENSE-SECRET";

function encryptLicense(value: string): string {
  const key = Buffer.from(process.env.VERIFICATION_INTERVENTION_ENCRYPTION_KEY ?? "", "base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

describe("Verification intervention admin API", () => {
  let app: INestApplication;
  let databaseService: DatabaseService;
  let factory: TestDataFactory;
  let adminCookie: string;
  let staffCookie: string;
  let staffId: string;
  let userCookie: string;

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

    const adminAuth = await factory.createAuthenticatedAdmin(uniqueEmail("intervention-admin"));
    adminCookie = adminAuth.cookie;
    const staffAuth = await factory.createAuthenticatedStaff(uniqueEmail("intervention-staff"));
    staffCookie = staffAuth.cookie;
    staffId = staffAuth.user.id;
    const userAuth = await factory.authenticateAndGetUser(uniqueEmail("intervention-user"), "user");
    userCookie = userAuth.cookie;
  });

  afterAll(async () => {
    await app.close();
  });

  async function seedOwnerTask(options?: {
    documentUserId?: string;
    documentStatus?: DocumentStatus;
  }) {
    const owner = await factory.createFleetOwner();
    await databaseService.user.update({
      where: { id: owner.id },
      data: { emailVerified: true, phoneVerifiedAt: new Date() },
    });
    await databaseService.bankDetails.create({
      data: {
        userId: owner.id,
        bankName: "Test Bank",
        bankCode: "001",
        accountNumber: "0123456789",
        accountName: "John Doe",
      },
    });
    const verification = await databaseService.fleetOwnerAccountVerification.create({
      data: {
        userId: owner.id,
        idempotencyKey: randomUUID(),
        requestHash: randomUUID(),
        accountType: FleetOwnerAccountType.INDIVIDUAL,
        isOwnerDriver: true,
        status: AccountVerificationStatus.REVIEW_REQUIRED,
        processingExpiresAt: new Date(Date.now() + 60_000),
        identityRequiresReview: false,
        bankNameMatch: NameMatchStatus.MATCHED,
        legalName: "John Doe",
        driversLicenseLast4: "DE67",
        driversLicenseDecision: VerificationDecisionStatus.PENDING,
      },
    });
    const document = await databaseService.documentApproval.create({
      data: {
        userId: options?.documentUserId ?? owner.id,
        documentType: DocumentType.DRIVERS_LICENSE,
        documentUrl: `private://license-${randomUUID()}.pdf`,
        status: options?.documentStatus ?? DocumentStatus.PENDING,
      },
    });
    const intervention = await databaseService.verificationIntervention.create({
      data: {
        resourceKey: `owner-license:${verification.id}`,
        kind: VerificationInterventionKind.OWNER_DRIVER_LICENSE,
        status: VerificationInterventionStatus.OPEN,
        accountVerificationId: verification.id,
        documentApprovalId: document.id,
        encryptedPayload: SECRET_PAYLOAD,
        retryAttempt: 2,
        emailNotifiedAt: new Date(),
      },
    });
    return { owner, verification, document, intervention };
  }

  function http(method: "get" | "post", path: string) {
    const server = app.getHttpServer();
    return method === "get" ? request(server).get(path) : request(server).post(path);
  }

  it("requires an admin or staff session and does not store the queue", async () => {
    const anonymous = await http("get", "/api/admin/verification-interventions");
    expect(anonymous.status).toBe(HttpStatus.UNAUTHORIZED);

    const forbidden = await http("get", "/api/admin/verification-interventions").set(
      "Cookie",
      userCookie,
    );
    expect(forbidden.status).toBe(HttpStatus.FORBIDDEN);

    const { owner, document, intervention } = await seedOwnerTask();
    const adminList = await http("get", "/api/admin/verification-interventions").set(
      "Cookie",
      adminCookie,
    );
    expect(adminList.status).toBe(HttpStatus.OK);
    expect(adminList.headers["cache-control"]).toBe("private, no-store");
    const listed = adminList.body.items.find((item: { id: string }) => item.id === intervention.id);
    expect(listed).toMatchObject({
      id: intervention.id,
      kind: VerificationInterventionKind.OWNER_DRIVER_LICENSE,
      licenseLast4: "DE67",
      document: {
        id: document.id,
        userId: owner.id,
        status: DocumentStatus.PENDING,
      },
    });
    expect(JSON.stringify(adminList.body)).not.toContain(SECRET_PAYLOAD);
    expect(JSON.stringify(adminList.body)).not.toContain(LICENSE_NUMBER);

    const staffList = await http("get", "/api/admin/verification-interventions").set(
      "Cookie",
      staffCookie,
    );
    expect(staffList.status).toBe(HttpStatus.OK);
    expect(staffList.headers["cache-control"]).toBe("private, no-store");

    const invalidQuery = await http(
      "get",
      "/api/admin/verification-interventions?status=WAITING",
    ).set("Cookie", adminCookie);
    expect(invalidQuery.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it("reveals a chauffeur licence only for an open chauffeur task and does not store it", async () => {
    const owner = await factory.createFleetOwner();
    const verification = await databaseService.chauffeurVerification.create({
      data: {
        fleetOwnerId: owner.id,
        name: "Ada Lovelace",
        firstName: "Ada",
        lastName: "Lovelace",
        email: uniqueEmail("intervention-chauffeur"),
        phoneNumber: `+23480${randomUUID().replaceAll("-", "").slice(0, 8)}`,
        invitationIdempotencyKey: randomUUID(),
        invitationRequestHash: randomUUID(),
        inviteTokenHash: randomUUID(),
        inviteExpiresAt: new Date(Date.now() + 86_400_000),
        driversLicenseLast4: "DE67",
        status: ChauffeurVerificationStatus.IDENTITY_VERIFIED,
      },
    });
    const intervention = await databaseService.verificationIntervention.create({
      data: {
        resourceKey: `chauffeur-license:${verification.id}`,
        kind: VerificationInterventionKind.CHAUFFEUR_DRIVERS_LICENSE,
        status: VerificationInterventionStatus.OPEN,
        chauffeurVerificationId: verification.id,
        encryptedPayload: encryptLicense(LICENSE_NUMBER),
        retryAttempt: 2,
        emailNotifiedAt: new Date(),
      },
    });

    const revealed = await http(
      "get",
      `/api/admin/verification-interventions/${intervention.id}/license-number`,
    ).set("Cookie", adminCookie);
    expect(revealed.status).toBe(HttpStatus.OK);
    expect(revealed.headers["cache-control"]).toBe("private, no-store");
    expect(revealed.body).toEqual({ licenseNumber: LICENSE_NUMBER });

    const ownerTask = await seedOwnerTask();
    const hidden = await http(
      "get",
      `/api/admin/verification-interventions/${ownerTask.intervention.id}/license-number`,
    ).set("Cookie", adminCookie);
    expect(hidden.status).toBe(HttpStatus.NOT_FOUND);
    expect(JSON.stringify(hidden.body)).not.toContain(LICENSE_NUMBER);

    const invalidId = await http(
      "get",
      "/api/admin/verification-interventions/not-a-uuid/license-number",
    ).set("Cookie", adminCookie);
    expect(invalidId.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it("does not let generic document approval resolve an owner intervention", async () => {
    const { verification, document, intervention } = await seedOwnerTask();

    const response = await http("post", `/api/admin/documents/${document.id}/approve`).set(
      "Cookie",
      adminCookie,
    );

    expect(response.status).toBe(HttpStatus.CREATED);
    const approvedDocument = await databaseService.documentApproval.findUniqueOrThrow({
      where: { id: document.id },
    });
    const stillOpen = await databaseService.verificationIntervention.findUniqueOrThrow({
      where: { id: intervention.id },
    });
    const account = await databaseService.fleetOwnerAccountVerification.findUniqueOrThrow({
      where: { id: verification.id },
    });
    expect(approvedDocument.status).toBe(DocumentStatus.APPROVED);
    expect(stillOpen.status).toBe(VerificationInterventionStatus.OPEN);
    expect(stillOpen.encryptedPayload).toBe(SECRET_PAYLOAD);
    expect(account.driversLicenseDecision).toBe(VerificationDecisionStatus.PENDING);
    expect(account.status).toBe(AccountVerificationStatus.REVIEW_REQUIRED);
  });

  it("approves only the document linked to the open owner intervention", async () => {
    const unrelatedOwner = await factory.createFleetOwner();
    const mismatched = await seedOwnerTask({ documentUserId: unrelatedOwner.id });
    const mismatchedResponse = await http(
      "post",
      `/api/admin/verification-interventions/${mismatched.intervention.id}/approve-document`,
    ).set("Cookie", adminCookie);
    expect(mismatchedResponse.status).toBe(HttpStatus.BAD_REQUEST);
    expect(mismatchedResponse.body.errorCode).toBe("INTERVENTION_EVIDENCE_REQUIRED");
    const mismatchedTask = await databaseService.verificationIntervention.findUniqueOrThrow({
      where: { id: mismatched.intervention.id },
    });
    expect(mismatchedTask.status).toBe(VerificationInterventionStatus.OPEN);

    const rejected = await seedOwnerTask({ documentStatus: DocumentStatus.REJECTED });
    const rejectedResponse = await http(
      "post",
      `/api/admin/verification-interventions/${rejected.intervention.id}/approve-document`,
    ).set("Cookie", adminCookie);
    expect(rejectedResponse.status).toBe(HttpStatus.BAD_REQUEST);
    expect(rejectedResponse.body.errorCode).toBe("INTERVENTION_EVIDENCE_REQUIRED");

    const { owner, verification, document, intervention } = await seedOwnerTask();
    const directApproval = await http(
      "post",
      `/api/admin/verification-interventions/${intervention.id}/approve`,
    )
      .set("Cookie", adminCookie)
      .send({
        notes: "Checked the upload",
        source: "UPLOAD",
        authoritativeSourceAttested: true,
      });
    expect(directApproval.status).toBe(HttpStatus.BAD_REQUEST);
    expect(directApproval.body.errorCode).toBe("INTERVENTION_EVIDENCE_REQUIRED");

    const anonymous = await http(
      "post",
      `/api/admin/verification-interventions/${intervention.id}/approve-document`,
    );
    expect(anonymous.status).toBe(HttpStatus.UNAUTHORIZED);

    const forbidden = await http(
      "post",
      `/api/admin/verification-interventions/${intervention.id}/approve-document`,
    ).set("Cookie", userCookie);
    expect(forbidden.status).toBe(HttpStatus.FORBIDDEN);

    const invalidId = await http(
      "post",
      "/api/admin/verification-interventions/not-a-uuid/approve-document",
    ).set("Cookie", adminCookie);
    expect(invalidId.status).toBe(HttpStatus.BAD_REQUEST);

    const approved = await http(
      "post",
      `/api/admin/verification-interventions/${intervention.id}/approve-document`,
    ).set("Cookie", staffCookie);
    expect(approved.status).toBe(HttpStatus.CREATED);
    expect(approved.body).toEqual({ success: true });

    const resolved = await databaseService.verificationIntervention.findUniqueOrThrow({
      where: { id: intervention.id },
    });
    const approvedDocument = await databaseService.documentApproval.findUniqueOrThrow({
      where: { id: document.id },
    });
    const account = await databaseService.fleetOwnerAccountVerification.findUniqueOrThrow({
      where: { id: verification.id },
    });
    const user = await databaseService.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(resolved).toMatchObject({
      status: VerificationInterventionStatus.APPROVED,
      encryptedPayload: null,
      resolvedById: staffId,
      resolutionSource: "UPLOADED_DOCUMENT",
    });
    expect(approvedDocument).toMatchObject({
      status: DocumentStatus.APPROVED,
      approvedById: resolved.resolvedById,
      notes: null,
    });
    expect(account).toMatchObject({
      driversLicenseDecision: VerificationDecisionStatus.APPROVED,
      status: AccountVerificationStatus.SUCCEEDED,
    });
    expect(user).toMatchObject({ fleetOwnerStatus: "APPROVED", hasOnboarded: true });
  });

  it("does not let face rejection mutate an approved chauffeur", async () => {
    const owner = await factory.createFleetOwner();
    const verification = await databaseService.chauffeurVerification.create({
      data: {
        fleetOwnerId: owner.id,
        name: "Grace Hopper",
        firstName: "Grace",
        lastName: "Hopper",
        email: uniqueEmail("approved-chauffeur"),
        phoneNumber: `+23481${randomUUID().replaceAll("-", "").slice(0, 8)}`,
        invitationIdempotencyKey: randomUUID(),
        invitationRequestHash: randomUUID(),
        inviteTokenHash: randomUUID(),
        inviteExpiresAt: new Date(Date.now() + 86_400_000),
        status: ChauffeurVerificationStatus.APPROVED,
        faceDecision: VerificationDecisionStatus.APPROVED,
        driversLicenseDecision: VerificationDecisionStatus.APPROVED,
        selfieObjectKey: "secret-selfie-key",
      },
    });
    const intervention = await databaseService.verificationIntervention.create({
      data: {
        resourceKey: `chauffeur-face:${verification.id}`,
        kind: VerificationInterventionKind.CHAUFFEUR_FACE,
        status: VerificationInterventionStatus.OPEN,
        chauffeurVerificationId: verification.id,
        retryAttempt: 2,
        emailNotifiedAt: new Date(),
      },
    });

    const missingNotes = await http(
      "post",
      `/api/admin/verification-interventions/${intervention.id}/reject`,
    )
      .set("Cookie", adminCookie)
      .send({});
    expect(missingNotes.status).toBe(HttpStatus.BAD_REQUEST);

    const rejected = await http(
      "post",
      `/api/admin/verification-interventions/${intervention.id}/reject`,
    )
      .set("Cookie", adminCookie)
      .send({ notes: "Photo does not match" });
    expect(rejected.status).toBe(HttpStatus.CONFLICT);
    expect(rejected.body.errorCode).toBe("VERIFICATION_INTERVENTION_RESOLVED");

    const chauffeur = await databaseService.chauffeurVerification.findUniqueOrThrow({
      where: { id: verification.id },
    });
    const task = await databaseService.verificationIntervention.findUniqueOrThrow({
      where: { id: intervention.id },
    });
    expect(chauffeur).toMatchObject({
      status: ChauffeurVerificationStatus.APPROVED,
      faceDecision: VerificationDecisionStatus.APPROVED,
      selfieObjectKey: "secret-selfie-key",
    });
    expect(task).toMatchObject({
      status: VerificationInterventionStatus.AUTO_RESOLVED,
      resolutionSource: "ALREADY_APPROVED",
    });
  });
});
