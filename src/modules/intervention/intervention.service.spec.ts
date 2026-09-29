import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import {
  AccountVerificationStatus,
  ChauffeurVerificationStatus,
  DocumentStatus,
  DocumentType,
  NameMatchStatus,
  type Prisma,
  VerificationDecisionStatus,
  VerificationInterventionKind,
  VerificationInterventionStatus,
} from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmailPublicEnv } from "@/email-public-env";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { DatabaseService } from "../database/database.service";
import { EmailService } from "../email/email.service";
import { StorageService } from "../storage/storage.service";
import { ChauffeurActivationService } from "./chauffeur-activation.service";
import {
  InterventionAlreadyResolvedException,
  InterventionEvidenceRequiredException,
  InterventionNotFoundException,
} from "./intervention.error";
import { InterventionService } from "./intervention.service";

const ENCRYPTION_KEY = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";
const OPERATIONS_EMAIL = "ops@example.com";
const OPENED_AT = new Date("2026-09-26T12:00:00.000Z");
const INTERVENTION_ID = "018f47a2-7b3c-7d4e-8f90-1234567894c1";
const VERIFICATION_ID = "018f47a2-7b3c-7d4e-8f90-1234567894a1";
const ACCOUNT_ID = "018f47a2-7b3c-7d4e-8f90-1234567894b1";
const USER_ID = "018f47a2-7b3c-7d4e-8f90-1234567894d1";
const LICENSE_NUMBER = "ABC12345DE67";
const DOCUMENT_ID = "018f47a2-7b3c-7d4e-8f90-1234567894e1";

type RawQuery = { strings: readonly string[]; values: readonly unknown[] };

function queryText(query: unknown): string {
  if (query && typeof query === "object" && "strings" in query && Array.isArray(query.strings)) {
    return (query as RawQuery).strings.join("");
  }
  throw new Error("Expected a Prisma.sql query");
}

function queryValues(query: unknown): readonly unknown[] {
  if (query && typeof query === "object" && "values" in query && Array.isArray(query.values)) {
    return (query as RawQuery).values;
  }
  throw new Error("Expected a Prisma.sql query");
}

function expectRowLock(
  query: unknown,
  table: "ChauffeurVerification" | "VerificationIntervention" | "DocumentApproval",
  id: string,
) {
  expect(queryText(query)).toBe(`SELECT id FROM "${table}" WHERE id = ::uuid FOR UPDATE`);
  expect(queryValues(query)).toEqual([id]);
}

describe("InterventionService", () => {
  let service: InterventionService;
  let database: {
    verificationIntervention: Record<string, ReturnType<typeof vi.fn>>;
    chauffeurVerification: Record<string, ReturnType<typeof vi.fn>>;
    chauffeurVerificationStageRequest: Record<string, ReturnType<typeof vi.fn>>;
    fleetOwnerAccountVerification: Record<string, ReturnType<typeof vi.fn>>;
    bankDetails: Record<string, ReturnType<typeof vi.fn>>;
    user: Record<string, ReturnType<typeof vi.fn>>;
    documentApproval: Record<string, ReturnType<typeof vi.fn>>;
    $transaction: ReturnType<typeof vi.fn>;
    $queryRaw: ReturnType<typeof vi.fn>;
  };
  let emailService: { sendEmail: ReturnType<typeof vi.fn> };
  let storageService: {
    deleteObjectByKey: ReturnType<typeof vi.fn>;
    getObjectStream: ReturnType<typeof vi.fn>;
  };
  let activation: { activateIfEligible: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    database = {
      verificationIntervention: {
        upsert: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        count: vi.fn().mockResolvedValue(0),
      },
      chauffeurVerification: {
        findUnique: vi.fn().mockResolvedValue({
          status: ChauffeurVerificationStatus.IDENTITY_VERIFIED,
          faceDecision: VerificationDecisionStatus.PENDING,
        }),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      chauffeurVerificationStageRequest: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      fleetOwnerAccountVerification: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
      },
      bankDetails: { updateMany: vi.fn() },
      user: { update: vi.fn() },
      documentApproval: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      $queryRaw: vi.fn().mockImplementation((query: unknown) => {
        const text = queryText(query);
        const id = queryValues(query)[0];
        const lockedTable = [
          "ChauffeurVerification",
          "VerificationIntervention",
          "DocumentApproval",
        ].find((table) => text === `SELECT id FROM "${table}" WHERE id = ::uuid FOR UPDATE`);
        if (!lockedTable || typeof id !== "string") {
          throw new Error(`Unexpected intervention lock query: ${text}`);
        }
        return [{ id }];
      }),
      $transaction: vi.fn(),
    };
    database.$transaction.mockImplementation(async (callback: (tx: typeof database) => unknown) =>
      callback(database),
    );
    database.verificationIntervention.upsert.mockImplementation(async ({ create }) => ({
      id: INTERVENTION_ID,
      status: VerificationInterventionStatus.OPEN,
      retryAttempt: 0,
      emailNotifiedAt: null,
      createdAt: OPENED_AT,
      chauffeurVerificationId: null,
      accountVerificationId: null,
      ...create,
    }));
    emailService = { sendEmail: vi.fn().mockResolvedValue(undefined) };
    storageService = {
      deleteObjectByKey: vi.fn().mockResolvedValue(undefined),
      getObjectStream: vi.fn(),
    };
    activation = { activateIfEligible: vi.fn().mockResolvedValue(true) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InterventionService,
        { provide: DatabaseService, useValue: database },
        { provide: EmailService, useValue: emailService },
        { provide: StorageService, useValue: storageService },
        { provide: ChauffeurActivationService, useValue: activation },
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn((key: string) => {
              if (key === "VERIFICATION_INTERVENTION_ENCRYPTION_KEY") return ENCRYPTION_KEY;
              if (key === "OPERATIONS_EMAIL") return OPERATIONS_EMAIL;
              return undefined;
            }),
          },
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get(InterventionService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function freezeOpenedAt() {
    vi.useFakeTimers();
    vi.setSystemTime(OPENED_AT);
  }

  function tx(): Prisma.TransactionClient {
    return database as unknown as Prisma.TransactionClient;
  }

  async function captureLicensePayload(licenseNumber = LICENSE_NUMBER) {
    freezeOpenedAt();
    await service.bindChauffeurLicense(tx(), VERIFICATION_ID, licenseNumber);
    return database.verificationIntervention.upsert.mock.calls[0][0].create
      .encryptedPayload as string;
  }

  describe("binding", () => {
    beforeEach(() => {
      freezeOpenedAt();
    });

    it("encrypts a fresh chauffeur licence and resets stale terminal audit fields", async () => {
      database.verificationIntervention.findUnique.mockResolvedValueOnce({
        id: INTERVENTION_ID,
        status: VerificationInterventionStatus.REJECTED,
        encryptedPayload: "stale-secret",
        retryAttempt: 2,
        resolutionNotes: "old note",
        resolvedById: USER_ID,
      });

      const bound = await service.bindChauffeurLicense(tx(), VERIFICATION_ID, LICENSE_NUMBER);

      expect(bound).toMatchObject({
        id: INTERVENTION_ID,
        status: VerificationInterventionStatus.OPEN,
      });
      const payload = database.verificationIntervention.upsert.mock.calls[0][0].create
        .encryptedPayload as string;
      expect(payload).not.toContain(LICENSE_NUMBER);
      expect(payload.split(".")).toHaveLength(3);
      expect(database.verificationIntervention.upsert).toHaveBeenCalledWith({
        where: { resourceKey: `chauffeur-license:${VERIFICATION_ID}` },
        create: {
          resourceKey: `chauffeur-license:${VERIFICATION_ID}`,
          kind: VerificationInterventionKind.CHAUFFEUR_DRIVERS_LICENSE,
          chauffeurVerificationId: VERIFICATION_ID,
          accountVerificationId: undefined,
          documentApprovalId: undefined,
          encryptedPayload: payload,
        },
        update: {
          kind: VerificationInterventionKind.CHAUFFEUR_DRIVERS_LICENSE,
          status: VerificationInterventionStatus.OPEN,
          chauffeurVerificationId: VERIFICATION_ID,
          accountVerificationId: undefined,
          documentApprovalId: undefined,
          encryptedPayload: payload,
          emailNotifiedAt: null,
          resolutionSource: null,
          resolutionNotes: null,
          resolvedAt: null,
          resolvedById: null,
          createdAt: OPENED_AT,
        },
      });
      expect(emailService.sendEmail).not.toHaveBeenCalled();
    });

    it("binds an owner licence to the uploaded document inside the caller transaction", async () => {
      const bound = await service.bindOwnerLicense(tx(), ACCOUNT_ID, DOCUMENT_ID, LICENSE_NUMBER);
      const payload = database.verificationIntervention.upsert.mock.calls[0][0].create
        .encryptedPayload as string;

      expect(bound).toMatchObject({ id: INTERVENTION_ID });
      expect(payload).not.toContain(LICENSE_NUMBER);
      expect(database.verificationIntervention.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { resourceKey: `owner-license:${ACCOUNT_ID}` },
          create: expect.objectContaining({
            kind: VerificationInterventionKind.OWNER_DRIVER_LICENSE,
            accountVerificationId: ACCOUNT_ID,
            documentApprovalId: DOCUMENT_ID,
            encryptedPayload: payload,
          }),
          update: expect.objectContaining({
            status: VerificationInterventionStatus.OPEN,
            documentApprovalId: DOCUMENT_ID,
            encryptedPayload: payload,
            resolutionNotes: null,
            resolvedById: null,
          }),
        }),
      );
    });

    it("refuses to overwrite evidence that is still open", async () => {
      database.verificationIntervention.findUnique
        .mockResolvedValueOnce({
          id: INTERVENTION_ID,
          status: VerificationInterventionStatus.OPEN,
          encryptedPayload: "existing-chauffeur-secret",
        })
        .mockResolvedValueOnce({
          id: INTERVENTION_ID,
          status: VerificationInterventionStatus.OPEN,
          encryptedPayload: "existing-owner-secret",
        });

      await expect(
        service.bindChauffeurLicense(tx(), VERIFICATION_ID, LICENSE_NUMBER),
      ).resolves.toBeNull();
      await expect(
        service.bindOwnerLicense(tx(), ACCOUNT_ID, DOCUMENT_ID, "LAG98765AB21"),
      ).resolves.toBeNull();

      expect(database.verificationIntervention.upsert).not.toHaveBeenCalled();
    });
  });

  describe("dispatch", () => {
    beforeEach(() => {
      freezeOpenedAt();
    });

    it("emails operations once and does not schedule a provider retry", async () => {
      database.verificationIntervention.findUnique.mockResolvedValueOnce({
        id: INTERVENTION_ID,
        status: VerificationInterventionStatus.OPEN,
        kind: VerificationInterventionKind.CHAUFFEUR_FACE,
        emailNotifiedAt: null,
      });

      await service.dispatchIntervention(INTERVENTION_ID);

      expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
      const email = emailService.sendEmail.mock.calls[0][0];
      expect(email.to).toBe(OPERATIONS_EMAIL);
      expect(email.html).toContain(`${getEmailPublicEnv().websiteUrl}/admin/interventions`);
      expect(database.verificationIntervention.updateMany).toHaveBeenCalledWith({
        where: { id: INTERVENTION_ID, emailNotifiedAt: null },
        data: { emailNotifiedAt: OPENED_AT },
      });
    });

    it("does not send a second email when open face evidence cannot be bound again", async () => {
      database.verificationIntervention.findUnique.mockResolvedValueOnce({
        id: INTERVENTION_ID,
        status: VerificationInterventionStatus.OPEN,
      });

      await expect(service.bindChauffeurFace(tx(), VERIFICATION_ID)).resolves.toBeNull();
      expect(database.verificationIntervention.upsert).not.toHaveBeenCalled();
      expect(emailService.sendEmail).not.toHaveBeenCalled();
    });

    it("releases the email claim when sending fails so repair can retry it", async () => {
      database.verificationIntervention.findUnique.mockResolvedValueOnce({
        id: INTERVENTION_ID,
        status: VerificationInterventionStatus.OPEN,
        kind: VerificationInterventionKind.CHAUFFEUR_DRIVERS_LICENSE,
        emailNotifiedAt: null,
      });
      emailService.sendEmail.mockRejectedValueOnce(new Error("smtp down"));

      await service.dispatchIntervention(INTERVENTION_ID);

      expect(database.verificationIntervention.updateMany).toHaveBeenLastCalledWith({
        where: { id: INTERVENTION_ID, emailNotifiedAt: OPENED_AT },
        data: { emailNotifiedAt: null },
      });
    });
  });

  describe("staff review", () => {
    it("paginates the queue without licence numbers, payloads, or photo bytes", async () => {
      database.verificationIntervention.findMany.mockResolvedValueOnce([
        {
          id: INTERVENTION_ID,
          kind: VerificationInterventionKind.CHAUFFEUR_DRIVERS_LICENSE,
          status: VerificationInterventionStatus.OPEN,
          retryAttempt: 1,
          createdAt: OPENED_AT,
          encryptedPayload: `secret.${LICENSE_NUMBER}`,
          chauffeurVerification: {
            name: "Ada Lovelace",
            driversLicenseLast4: "DE67",
            selfieObjectKey: "secret-selfie-key",
            identityOfficialPhoto: "secret-photo-bytes",
          },
          accountVerification: null,
          documentApproval: null,
        },
      ]);
      database.verificationIntervention.count.mockResolvedValueOnce(21);

      const result = await service.list({
        status: VerificationInterventionStatus.OPEN,
        page: 2,
        limit: 20,
      });

      expect(database.verificationIntervention.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 20, orderBy: { createdAt: "asc" } }),
      );
      expect(result.meta).toEqual({ page: 2, limit: 20, total: 21, totalPages: 2 });
      expect(result.items[0]).toEqual({
        id: INTERVENTION_ID,
        kind: VerificationInterventionKind.CHAUFFEUR_DRIVERS_LICENSE,
        status: VerificationInterventionStatus.OPEN,
        applicantName: "Ada Lovelace",
        licenseLast4: "DE67",
        hasSelfie: true,
        hasNinPortrait: true,
        document: null,
        createdAt: OPENED_AT,
      });
      expect(result.items[0]).not.toHaveProperty("retryAttempt");
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(LICENSE_NUMBER);
      expect(serialized).not.toContain("secret-selfie-key");
      expect(serialized).not.toContain("secret-photo-bytes");
    });

    it("returns one review and hides a missing one", async () => {
      database.verificationIntervention.findUnique.mockResolvedValueOnce({
        id: INTERVENTION_ID,
        kind: VerificationInterventionKind.CHAUFFEUR_DRIVERS_LICENSE,
        status: VerificationInterventionStatus.OPEN,
        createdAt: OPENED_AT,
        encryptedPayload: `secret.${LICENSE_NUMBER}`,
        chauffeurVerification: {
          name: "Ada Lovelace",
          driversLicenseLast4: "DE67",
          selfieObjectKey: "secret-selfie-key",
          identityOfficialPhoto: null,
        },
        accountVerification: null,
        documentApproval: null,
      });

      const result = await service.get(INTERVENTION_ID);
      expect(result).toEqual({
        id: INTERVENTION_ID,
        kind: VerificationInterventionKind.CHAUFFEUR_DRIVERS_LICENSE,
        status: VerificationInterventionStatus.OPEN,
        applicantName: "Ada Lovelace",
        licenseLast4: "DE67",
        hasSelfie: true,
        hasNinPortrait: false,
        document: null,
        createdAt: OPENED_AT,
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(LICENSE_NUMBER);
      expect(serialized).not.toContain("secret-selfie-key");

      database.verificationIntervention.findUnique.mockResolvedValueOnce(null);
      await expect(service.get(INTERVENTION_ID)).rejects.toBeInstanceOf(
        InterventionNotFoundException,
      );
    });

    it("reveals a full chauffeur licence only for an open licence task", async () => {
      const encryptedPayload = await captureLicensePayload();
      database.verificationIntervention.findUnique.mockResolvedValue({
        id: INTERVENTION_ID,
        kind: VerificationInterventionKind.CHAUFFEUR_DRIVERS_LICENSE,
        status: VerificationInterventionStatus.OPEN,
        encryptedPayload,
      });

      await expect(service.getLicenseNumber(INTERVENTION_ID)).resolves.toBe(LICENSE_NUMBER);

      database.verificationIntervention.findUnique.mockResolvedValue({
        id: INTERVENTION_ID,
        kind: VerificationInterventionKind.OWNER_DRIVER_LICENSE,
        status: VerificationInterventionStatus.OPEN,
        encryptedPayload,
      });
      await expect(service.getLicenseNumber(INTERVENTION_ID)).rejects.toBeInstanceOf(
        InterventionNotFoundException,
      );
    });

    it("rejects a tampered licence payload", async () => {
      const encryptedPayload = await captureLicensePayload();
      const [iv, tag, body] = encryptedPayload.split(".");
      const index = Math.min(1, body.length - 1);
      const mutatedBody = `${body.slice(0, index)}${body[index] === "A" ? "B" : "A"}${body.slice(index + 1)}`;
      database.verificationIntervention.findUnique.mockResolvedValue({
        id: INTERVENTION_ID,
        kind: VerificationInterventionKind.CHAUFFEUR_DRIVERS_LICENSE,
        status: VerificationInterventionStatus.OPEN,
        encryptedPayload: `${iv}.${tag}.${mutatedBody}`,
      });

      await expect(service.getLicenseNumber(INTERVENTION_ID)).rejects.toThrow();
    });

    it("returns face evidence only for an open face task", async () => {
      const stream = { pipe: vi.fn() };
      storageService.getObjectStream.mockResolvedValueOnce({
        stream,
        contentType: "image/webp",
        contentLength: 4,
      });
      database.verificationIntervention.findUnique.mockResolvedValueOnce({
        id: INTERVENTION_ID,
        kind: VerificationInterventionKind.CHAUFFEUR_FACE,
        status: VerificationInterventionStatus.OPEN,
        chauffeurVerification: { selfieObjectKey: "selfie-key" },
      });

      await expect(service.getSelfie(INTERVENTION_ID)).resolves.toMatchObject({
        contentType: "image/webp",
      });
      expect(storageService.getObjectStream).toHaveBeenCalledWith("selfie-key");

      database.verificationIntervention.findUnique.mockResolvedValueOnce({
        id: INTERVENTION_ID,
        kind: VerificationInterventionKind.CHAUFFEUR_DRIVERS_LICENSE,
        status: VerificationInterventionStatus.OPEN,
        chauffeurVerification: { selfieObjectKey: "selfie-key" },
      });
      await expect(service.getSelfie(INTERVENTION_ID)).rejects.toBeInstanceOf(
        InterventionNotFoundException,
      );
    });

    it("decodes an open face task NIN portrait and rejects an empty one", async () => {
      database.verificationIntervention.findUnique.mockResolvedValueOnce({
        id: INTERVENTION_ID,
        kind: VerificationInterventionKind.CHAUFFEUR_FACE,
        status: VerificationInterventionStatus.OPEN,
        chauffeurVerification: { identityOfficialPhoto: "data:image/jpeg;base64,QQ==" },
      });

      await expect(service.getNinPortrait(INTERVENTION_ID)).resolves.toEqual(Buffer.from("A"));

      database.verificationIntervention.findUnique.mockResolvedValueOnce({
        id: INTERVENTION_ID,
        kind: VerificationInterventionKind.CHAUFFEUR_FACE,
        status: VerificationInterventionStatus.OPEN,
        chauffeurVerification: { identityOfficialPhoto: "data:image/jpeg;base64," },
      });
      await expect(service.getNinPortrait(INTERVENTION_ID)).rejects.toBeInstanceOf(
        InterventionNotFoundException,
      );
    });

    it("requires independent-source attestation before approving a chauffeur licence", async () => {
      database.verificationIntervention.findUnique.mockResolvedValue({
        id: INTERVENTION_ID,
        kind: VerificationInterventionKind.CHAUFFEUR_DRIVERS_LICENSE,
        status: VerificationInterventionStatus.OPEN,
        chauffeurVerificationId: VERIFICATION_ID,
        encryptedPayload: "payload",
      });

      await expect(
        service.approve(INTERVENTION_ID, USER_ID, {
          notes: "Checked the portal",
          source: "FRSC",
          authoritativeSourceAttested: false,
        }),
      ).rejects.toBeInstanceOf(InterventionEvidenceRequiredException);
      expect(database.verificationIntervention.updateMany).not.toHaveBeenCalled();

      await service.approve(INTERVENTION_ID, USER_ID, {
        notes: "Checked the portal",
        source: "FRSC",
        authoritativeSourceAttested: true,
      });

      expect(database.verificationIntervention.updateMany).toHaveBeenCalledWith({
        where: { id: INTERVENTION_ID, status: VerificationInterventionStatus.OPEN },
        data: expect.objectContaining({
          status: VerificationInterventionStatus.APPROVED,
          encryptedPayload: null,
          resolvedById: USER_ID,
          resolutionSource: "FRSC",
        }),
      });
      expect(activation.activateIfEligible).toHaveBeenCalledWith(VERIFICATION_ID);
    });

    it("reopens a reviewer-approved chauffeur licence when activation fails", async () => {
      database.verificationIntervention.findUnique.mockResolvedValue({
        id: INTERVENTION_ID,
        kind: VerificationInterventionKind.CHAUFFEUR_DRIVERS_LICENSE,
        status: VerificationInterventionStatus.OPEN,
        chauffeurVerificationId: VERIFICATION_ID,
        encryptedPayload: "sealed-licence",
      });
      activation.activateIfEligible.mockRejectedValueOnce(new Error("chauffeur activation failed"));

      await expect(
        service.approve(INTERVENTION_ID, USER_ID, {
          notes: "Checked the portal",
          source: "FRSC",
          authoritativeSourceAttested: true,
        }),
      ).rejects.toThrow("chauffeur activation failed");

      expect(database.verificationIntervention.updateMany).toHaveBeenCalledWith({
        where: {
          id: INTERVENTION_ID,
          status: VerificationInterventionStatus.APPROVED,
        },
        data: {
          status: VerificationInterventionStatus.OPEN,
          resolvedAt: null,
          resolvedById: null,
          resolutionNotes: null,
          resolutionSource: null,
          encryptedPayload: "sealed-licence",
        },
      });
    });

    it("refuses direct approval of an owner-driver licence intervention", async () => {
      database.verificationIntervention.findUnique.mockResolvedValue({
        id: INTERVENTION_ID,
        kind: VerificationInterventionKind.OWNER_DRIVER_LICENSE,
        status: VerificationInterventionStatus.OPEN,
      });

      await expect(
        service.approve(INTERVENTION_ID, USER_ID, {
          notes: "Document looks valid",
          source: "UPLOAD",
          authoritativeSourceAttested: true,
        }),
      ).rejects.toBeInstanceOf(InterventionEvidenceRequiredException);
    });

    it("throws when staff approval loses the resolution race", async () => {
      database.verificationIntervention.findUnique.mockResolvedValue({
        id: INTERVENTION_ID,
        kind: VerificationInterventionKind.CHAUFFEUR_FACE,
        status: VerificationInterventionStatus.OPEN,
        chauffeurVerificationId: VERIFICATION_ID,
      });
      database.verificationIntervention.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(
        service.approve(INTERVENTION_ID, USER_ID, {
          notes: "Faces match",
          source: "VISUAL_COMPARISON",
          authoritativeSourceAttested: false,
        }),
      ).rejects.toBeInstanceOf(InterventionAlreadyResolvedException);
      expect(activation.activateIfEligible).not.toHaveBeenCalled();
    });

    it("reopens a reviewer-approved face task when activation fails", async () => {
      database.verificationIntervention.findUnique.mockResolvedValue({
        id: INTERVENTION_ID,
        kind: VerificationInterventionKind.CHAUFFEUR_FACE,
        status: VerificationInterventionStatus.OPEN,
        chauffeurVerificationId: VERIFICATION_ID,
      });
      activation.activateIfEligible.mockRejectedValueOnce(new Error("chauffeur activation failed"));

      await expect(
        service.approve(INTERVENTION_ID, USER_ID, {
          notes: "Faces match",
          source: "VISUAL_COMPARISON",
          authoritativeSourceAttested: false,
        }),
      ).rejects.toThrow("chauffeur activation failed");

      expect(database.verificationIntervention.updateMany).toHaveBeenCalledWith({
        where: {
          id: INTERVENTION_ID,
          status: VerificationInterventionStatus.APPROVED,
        },
        data: {
          status: VerificationInterventionStatus.OPEN,
          resolvedAt: null,
          resolvedById: null,
          resolutionNotes: null,
          resolutionSource: null,
        },
      });
    });

    it("rejects an open task, purges the payload and selfie, and conflicts if already resolved", async () => {
      database.verificationIntervention.findUnique.mockResolvedValue({
        id: INTERVENTION_ID,
        kind: VerificationInterventionKind.CHAUFFEUR_FACE,
        status: VerificationInterventionStatus.OPEN,
        chauffeurVerificationId: VERIFICATION_ID,
      });
      database.chauffeurVerification.findUnique.mockResolvedValue({
        selfieObjectKey: "selfie-key",
      });

      await service.reject(INTERVENTION_ID, USER_ID, "Photo does not match");

      expect(database.verificationIntervention.updateMany).toHaveBeenCalledWith({
        where: { id: INTERVENTION_ID, status: VerificationInterventionStatus.OPEN },
        data: expect.objectContaining({
          status: VerificationInterventionStatus.REJECTED,
          encryptedPayload: null,
          resolvedById: USER_ID,
          resolutionSource: "STAFF_REVIEW",
        }),
      });
      expect(database.chauffeurVerification.update).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID },
        data: expect.objectContaining({
          faceDecision: VerificationDecisionStatus.REJECTED,
          selfieObjectKey: null,
        }),
      });
      expect(storageService.deleteObjectByKey).toHaveBeenCalledWith("selfie-key");

      database.verificationIntervention.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.reject(INTERVENTION_ID, USER_ID, "Again")).rejects.toBeInstanceOf(
        InterventionAlreadyResolvedException,
      );
    });

    it("requests a retake by clearing the stored selfie so another one can be submitted", async () => {
      database.verificationIntervention.findUnique.mockResolvedValue({
        id: INTERVENTION_ID,
        kind: VerificationInterventionKind.CHAUFFEUR_FACE,
        status: VerificationInterventionStatus.OPEN,
        chauffeurVerificationId: VERIFICATION_ID,
      });
      database.chauffeurVerification.findUnique.mockResolvedValue({
        selfieObjectKey: "selfie-key",
      });

      await service.requestRetake(INTERVENTION_ID, USER_ID, "Take another photo");

      expect(database.verificationIntervention.updateMany).toHaveBeenCalledWith({
        where: { id: INTERVENTION_ID, status: VerificationInterventionStatus.OPEN },
        data: expect.objectContaining({
          status: VerificationInterventionStatus.RETAKE_REQUESTED,
          resolvedById: USER_ID,
          resolutionNotes: "Take another photo",
          resolutionSource: "STAFF_REVIEW",
        }),
      });
      expect(database.chauffeurVerification.update).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID },
        data: {
          selfieObjectKey: null,
          selfieRetakeRequired: true,
          faceDecision: VerificationDecisionStatus.PENDING,
          livenessProviderRef: null,
        },
      });
      expect(storageService.deleteObjectByKey).toHaveBeenCalledWith("selfie-key");
    });

    it("does not change an approved chauffeur when staff approve or reject the face task", async () => {
      const faceTask = {
        id: INTERVENTION_ID,
        kind: VerificationInterventionKind.CHAUFFEUR_FACE,
        status: VerificationInterventionStatus.OPEN,
        chauffeurVerificationId: VERIFICATION_ID,
      };
      database.verificationIntervention.findUnique.mockResolvedValue(faceTask);
      database.chauffeurVerification.findUnique.mockResolvedValue({
        status: ChauffeurVerificationStatus.APPROVED,
        faceDecision: VerificationDecisionStatus.APPROVED,
        selfieObjectKey: "selfie-key",
      });

      await expect(
        service.approve(INTERVENTION_ID, USER_ID, {
          notes: "Faces match",
          source: "VISUAL_COMPARISON",
          authoritativeSourceAttested: false,
        }),
      ).rejects.toBeInstanceOf(InterventionAlreadyResolvedException);
      await expect(
        service.reject(INTERVENTION_ID, USER_ID, "Photo does not match"),
      ).rejects.toBeInstanceOf(InterventionAlreadyResolvedException);

      expect(database.chauffeurVerification.update).not.toHaveBeenCalled();
      expect(storageService.deleteObjectByKey).not.toHaveBeenCalled();
      expect(activation.activateIfEligible).not.toHaveBeenCalled();
      expect(database.verificationIntervention.updateMany).toHaveBeenCalledWith({
        where: { id: INTERVENTION_ID, status: VerificationInterventionStatus.OPEN },
        data: expect.objectContaining({
          status: VerificationInterventionStatus.AUTO_RESOLVED,
          resolutionSource: "ALREADY_APPROVED",
        }),
      });
      const locks = database.$queryRaw.mock.calls.map((call) => call[0]);
      expect(locks).toHaveLength(2);
      for (const lock of locks) {
        expectRowLock(lock, "ChauffeurVerification", VERIFICATION_ID);
      }
    });

    it("approves the linked owner licence document without activating the account", async () => {
      database.verificationIntervention.findUnique.mockResolvedValue({
        id: INTERVENTION_ID,
        kind: VerificationInterventionKind.OWNER_DRIVER_LICENSE,
        status: VerificationInterventionStatus.OPEN,
        accountVerificationId: ACCOUNT_ID,
        documentApprovalId: DOCUMENT_ID,
        encryptedPayload: "secret-payload",
        accountVerification: { id: ACCOUNT_ID, userId: USER_ID },
      });
      database.documentApproval.findUnique.mockResolvedValue({
        id: DOCUMENT_ID,
        userId: USER_ID,
        documentType: DocumentType.DRIVERS_LICENSE,
        status: DocumentStatus.PENDING,
      });
      database.fleetOwnerAccountVerification.findUnique.mockResolvedValue({
        id: ACCOUNT_ID,
        userId: USER_ID,
        status: AccountVerificationStatus.REVIEW_REQUIRED,
        identityRequiresReview: false,
        bankNameMatch: NameMatchStatus.MATCHED,
        user: {
          emailVerified: true,
          phoneVerifiedAt: new Date("2026-09-01T00:00:00.000Z"),
        },
      });
      database.bankDetails.updateMany.mockResolvedValue({ count: 1 });

      await service.approveOwnerLicenseDocument(INTERVENTION_ID, USER_ID);

      expectRowLock(
        database.$queryRaw.mock.calls[0][0],
        "VerificationIntervention",
        INTERVENTION_ID,
      );
      expectRowLock(database.$queryRaw.mock.calls[1][0], "DocumentApproval", DOCUMENT_ID);
      expect(database.documentApproval.update).toHaveBeenCalledWith({
        where: { id: DOCUMENT_ID },
        data: expect.objectContaining({
          status: DocumentStatus.APPROVED,
          approvedById: USER_ID,
          notes: null,
        }),
      });
      expect(database.verificationIntervention.updateMany).toHaveBeenCalledWith({
        where: { id: INTERVENTION_ID, status: VerificationInterventionStatus.OPEN },
        data: expect.objectContaining({
          status: VerificationInterventionStatus.APPROVED,
          encryptedPayload: null,
          resolvedById: USER_ID,
          resolutionSource: "UPLOADED_DOCUMENT",
          resolutionNotes: "Provider outage replaced by the linked private document",
        }),
      });
      expect(database.fleetOwnerAccountVerification.update).toHaveBeenCalledWith({
        where: { id: ACCOUNT_ID },
        data: { driversLicenseDecision: VerificationDecisionStatus.APPROVED },
      });
      expect(database.user.update).not.toHaveBeenCalled();
      expect(database.bankDetails.updateMany).not.toHaveBeenCalled();
    });

    it("rejects an owner document that is not the linked driver's licence", async () => {
      database.verificationIntervention.findUnique.mockResolvedValue({
        id: INTERVENTION_ID,
        kind: VerificationInterventionKind.OWNER_DRIVER_LICENSE,
        status: VerificationInterventionStatus.OPEN,
        accountVerificationId: ACCOUNT_ID,
        documentApprovalId: DOCUMENT_ID,
        accountVerification: { id: ACCOUNT_ID, userId: USER_ID },
      });
      database.documentApproval.findUnique.mockResolvedValue({
        id: DOCUMENT_ID,
        userId: "someone-else",
        documentType: DocumentType.DRIVERS_LICENSE,
        status: DocumentStatus.PENDING,
      });

      await expect(
        service.approveOwnerLicenseDocument(INTERVENTION_ID, USER_ID),
      ).rejects.toBeInstanceOf(InterventionEvidenceRequiredException);

      expect(database.documentApproval.update).not.toHaveBeenCalled();
      expect(database.verificationIntervention.updateMany).not.toHaveBeenCalled();
      expect(database.fleetOwnerAccountVerification.update).not.toHaveBeenCalled();
    });

    it("does not approve the account when the intervention resolution loses", async () => {
      database.verificationIntervention.findUnique.mockResolvedValue({
        id: INTERVENTION_ID,
        kind: VerificationInterventionKind.OWNER_DRIVER_LICENSE,
        status: VerificationInterventionStatus.OPEN,
        accountVerificationId: ACCOUNT_ID,
        documentApprovalId: DOCUMENT_ID,
        accountVerification: { id: ACCOUNT_ID, userId: USER_ID },
      });
      database.documentApproval.findUnique.mockResolvedValue({
        id: DOCUMENT_ID,
        userId: USER_ID,
        documentType: DocumentType.DRIVERS_LICENSE,
        status: DocumentStatus.PENDING,
      });
      database.verificationIntervention.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(
        service.approveOwnerLicenseDocument(INTERVENTION_ID, USER_ID),
      ).rejects.toBeInstanceOf(InterventionAlreadyResolvedException);

      expect(database.documentApproval.update).toHaveBeenCalledTimes(1);
      expect(database.fleetOwnerAccountVerification.update).not.toHaveBeenCalled();
      expect(database.user.update).not.toHaveBeenCalled();
    });

    function stageRecoverableOwnerLicence(user: {
      emailVerified: boolean;
      phoneVerifiedAt: Date | null;
    }) {
      database.verificationIntervention.findUnique.mockResolvedValue({
        id: INTERVENTION_ID,
        kind: VerificationInterventionKind.OWNER_DRIVER_LICENSE,
        status: VerificationInterventionStatus.OPEN,
        accountVerificationId: ACCOUNT_ID,
        documentApprovalId: DOCUMENT_ID,
        accountVerification: { id: ACCOUNT_ID, userId: USER_ID },
      });
      database.documentApproval.findUnique.mockResolvedValue({
        id: DOCUMENT_ID,
        userId: USER_ID,
        documentType: DocumentType.DRIVERS_LICENSE,
        status: DocumentStatus.PENDING,
      });
      database.fleetOwnerAccountVerification.findUnique.mockResolvedValue({
        id: ACCOUNT_ID,
        userId: USER_ID,
        status: AccountVerificationStatus.REVIEW_REQUIRED,
        identityRequiresReview: false,
        bankNameMatch: NameMatchStatus.MATCHED,
        user,
      });
    }

    it.each([
      ["email", { emailVerified: false, phoneVerifiedAt: new Date("2026-09-01T00:00:00.000Z") }],
      ["phone", { emailVerified: true, phoneVerifiedAt: null }],
    ] as const)(
      "approves the licence document when %s is unverified and leaves the account in review",
      async (_contact, user) => {
        stageRecoverableOwnerLicence(user);

        await service.approveOwnerLicenseDocument(INTERVENTION_ID, USER_ID);

        expect(database.bankDetails.updateMany).not.toHaveBeenCalled();
        expect(database.user.update).not.toHaveBeenCalled();
        expect(database.fleetOwnerAccountVerification.update).toHaveBeenCalledWith({
          where: { id: ACCOUNT_ID },
          data: { driversLicenseDecision: VerificationDecisionStatus.APPROVED },
        });
      },
    );

    it("does not touch the bank row when approving the licence document", async () => {
      stageRecoverableOwnerLicence({
        emailVerified: true,
        phoneVerifiedAt: new Date("2026-09-01T00:00:00.000Z"),
      });

      await service.approveOwnerLicenseDocument(INTERVENTION_ID, USER_ID);

      expect(database.bankDetails.updateMany).not.toHaveBeenCalled();
      expect(database.user.update).not.toHaveBeenCalled();
    });
  });
});
