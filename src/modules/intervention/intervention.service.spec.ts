import { getQueueToken } from "@nestjs/bullmq";
import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import {
  AccountVerificationStatus,
  ChauffeurVerificationStatus,
  DocumentStatus,
  DocumentType,
  FleetOwnerStatus,
  NameMatchStatus,
  type Prisma,
  VerificationDecisionStatus,
  VerificationInterventionKind,
  VerificationInterventionStatus,
} from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmailPublicEnv } from "@/email-public-env";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import {
  VERIFICATION_INTERVENTION_QUEUE,
  VERIFICATION_INTERVENTION_RETRY_JOB,
} from "../../config/constants";
import { DatabaseService } from "../database/database.service";
import { DriversLicenseLookupService } from "../drivers-license/drivers-license-lookup.service";
import { EmailService } from "../email/email.service";
import { MonoError } from "../mono/mono.service";
import { PremblyError } from "../prembly/prembly.service";
import { SmileIdError, SmileIdService } from "../smile-id/smile-id.service";
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
const DATE_OF_BIRTH = new Date(Date.UTC(1990, 0, 1));

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

const matchingLicense = {
  licenseNumber: LICENSE_NUMBER,
  firstName: "ADA",
  middleName: null,
  lastName: "LOVELACE",
  dateOfBirth: DATE_OF_BIRTH,
  expiresAt: new Date(Date.UTC(2099, 11, 31)),
  officialPhoto: "photo",
  reference: "lic-ref",
};

describe("InterventionService", () => {
  let service: InterventionService;
  let logger: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
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
  let licenseLookup: { lookup: ReturnType<typeof vi.fn> };
  let smileIdService: { comparisonStatus: ReturnType<typeof vi.fn> };
  let emailService: { sendEmail: ReturnType<typeof vi.fn> };
  let storageService: {
    deleteObjectByKey: ReturnType<typeof vi.fn>;
    getObjectStream: ReturnType<typeof vi.fn>;
  };
  let activation: { activateIfEligible: ReturnType<typeof vi.fn> };
  let queue: { add: ReturnType<typeof vi.fn> };

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
    licenseLookup = { lookup: vi.fn() };
    smileIdService = { comparisonStatus: vi.fn() };
    emailService = { sendEmail: vi.fn().mockResolvedValue(undefined) };
    storageService = {
      deleteObjectByKey: vi.fn().mockResolvedValue(undefined),
      getObjectStream: vi.fn(),
    };
    activation = { activateIfEligible: vi.fn().mockResolvedValue(true) };
    queue = { add: vi.fn().mockResolvedValue({ id: "job" }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InterventionService,
        { provide: DatabaseService, useValue: database },
        { provide: DriversLicenseLookupService, useValue: licenseLookup },
        { provide: SmileIdService, useValue: smileIdService },
        { provide: EmailService, useValue: emailService },
        { provide: StorageService, useValue: storageService },
        { provide: ChauffeurActivationService, useValue: activation },
        { provide: getQueueToken(VERIFICATION_INTERVENTION_QUEUE), useValue: queue },
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
    logger = module.get(PinoLogger);
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

  function consumedRetryAttempt(): boolean {
    return database.verificationIntervention.updateMany.mock.calls.some((call) => {
      const argument = call[0] as { data?: { retryAttempt?: number } };
      return argument.data?.retryAttempt !== undefined;
    });
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
          retryAttempt: 0,
          lastAttemptAt: null,
          emailNotifiedAt: null,
          resolutionSource: null,
          resolutionNotes: null,
          resolvedAt: null,
          resolvedById: null,
          createdAt: OPENED_AT,
        },
      });
      expect(queue.add).not.toHaveBeenCalled();
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
            retryAttempt: 0,
            resolutionNotes: null,
            resolvedById: null,
          }),
        }),
      );
      expect(queue.add).not.toHaveBeenCalled();
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

    it("cancels only an open prepared intervention and clears its payload", async () => {
      await service.cancelPreparedIntervention(tx(), INTERVENTION_ID, "SUBMISSION_FAILED");

      expect(database.verificationIntervention.updateMany).toHaveBeenCalledWith({
        where: { id: INTERVENTION_ID, status: VerificationInterventionStatus.OPEN },
        data: expect.objectContaining({
          status: VerificationInterventionStatus.REJECTED,
          encryptedPayload: null,
          resolutionSource: "SUBMISSION_FAILED",
        }),
      });
    });
  });

  describe("dispatch", () => {
    beforeEach(() => {
      freezeOpenedAt();
    });

    it("schedules stable retries and emails operations once after the licence commits", async () => {
      await service.bindChauffeurLicense(tx(), VERIFICATION_ID, LICENSE_NUMBER);
      database.verificationIntervention.findUnique.mockResolvedValueOnce({
        id: INTERVENTION_ID,
        status: VerificationInterventionStatus.OPEN,
        kind: VerificationInterventionKind.CHAUFFEUR_DRIVERS_LICENSE,
        createdAt: OPENED_AT,
        retryAttempt: 0,
        emailNotifiedAt: null,
      });

      await service.dispatchIntervention(INTERVENTION_ID);

      const payload = database.verificationIntervention.upsert.mock.calls[0][0].create
        .encryptedPayload as string;
      expect(payload).not.toContain(LICENSE_NUMBER);
      expect(queue.add).toHaveBeenCalledTimes(2);
      expect(queue.add).toHaveBeenNthCalledWith(
        1,
        VERIFICATION_INTERVENTION_RETRY_JOB,
        { interventionId: INTERVENTION_ID, attempt: 1 },
        expect.objectContaining({
          delay: 15 * 60 * 1000,
          jobId: `verification-intervention-${INTERVENTION_ID}-1`,
          attempts: 3,
          backoff: { type: "exponential", delay: 30_000 },
        }),
      );
      expect(queue.add).toHaveBeenNthCalledWith(
        2,
        VERIFICATION_INTERVENTION_RETRY_JOB,
        { interventionId: INTERVENTION_ID, attempt: 2 },
        expect.objectContaining({
          delay: 30 * 60 * 1000,
          jobId: `verification-intervention-${INTERVENTION_ID}-2`,
        }),
      );
      expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
      const email = emailService.sendEmail.mock.calls[0][0];
      expect(email.to).toBe(OPERATIONS_EMAIL);
      expect(email.html).toContain(`${getEmailPublicEnv().websiteUrl}/admin/interventions`);
      expect(email.html).not.toContain(LICENSE_NUMBER);
    });

    it("does not send a second email when open evidence cannot be bound again", async () => {
      await service.bindChauffeurLicense(tx(), VERIFICATION_ID, LICENSE_NUMBER);
      database.verificationIntervention.findUnique.mockResolvedValueOnce({
        id: INTERVENTION_ID,
        status: VerificationInterventionStatus.OPEN,
        kind: VerificationInterventionKind.CHAUFFEUR_DRIVERS_LICENSE,
        createdAt: OPENED_AT,
        retryAttempt: 0,
        emailNotifiedAt: null,
      });
      await service.dispatchIntervention(INTERVENTION_ID);

      database.verificationIntervention.findUnique.mockResolvedValueOnce({
        id: INTERVENTION_ID,
        status: VerificationInterventionStatus.OPEN,
        encryptedPayload: "kept-secret",
      });
      database.verificationIntervention.upsert.mockClear();

      await expect(
        service.bindChauffeurLicense(tx(), VERIFICATION_ID, "LAG98765AB21"),
      ).resolves.toBeNull();

      expect(database.verificationIntervention.upsert).not.toHaveBeenCalled();
      expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledTimes(2);
    });

    it("skips the email when another worker already claimed notification", async () => {
      database.verificationIntervention.findUnique.mockResolvedValueOnce({
        id: INTERVENTION_ID,
        status: VerificationInterventionStatus.OPEN,
        kind: VerificationInterventionKind.CHAUFFEUR_FACE,
        createdAt: OPENED_AT,
        retryAttempt: 0,
        emailNotifiedAt: null,
      });
      database.verificationIntervention.updateMany.mockResolvedValueOnce({ count: 0 });

      await service.openChauffeurFace(VERIFICATION_ID);

      expect(database.$queryRaw).toHaveBeenCalledTimes(1);
      expectRowLock(database.$queryRaw.mock.calls[0][0], "ChauffeurVerification", VERIFICATION_ID);
      expect(database.verificationIntervention.updateMany).toHaveBeenCalledWith({
        where: { id: INTERVENTION_ID, emailNotifiedAt: null },
        data: { emailNotifiedAt: OPENED_AT },
      });
      expect(emailService.sendEmail).not.toHaveBeenCalled();
    });

    it("releases the email claim when sending fails so repair can retry it", async () => {
      await service.bindOwnerLicense(tx(), ACCOUNT_ID, DOCUMENT_ID, LICENSE_NUMBER);
      database.verificationIntervention.findUnique.mockResolvedValueOnce({
        id: INTERVENTION_ID,
        status: VerificationInterventionStatus.OPEN,
        kind: VerificationInterventionKind.OWNER_DRIVER_LICENSE,
        createdAt: OPENED_AT,
        retryAttempt: 0,
        emailNotifiedAt: null,
      });
      emailService.sendEmail.mockRejectedValueOnce(new Error("smtp down"));

      await service.dispatchIntervention(INTERVENTION_ID);

      expect(database.verificationIntervention.updateMany).toHaveBeenLastCalledWith({
        where: { id: INTERVENTION_ID, emailNotifiedAt: OPENED_AT },
        data: { emailNotifiedAt: null },
      });
      expect(logger.warn).toHaveBeenCalled();
      const warning = JSON.stringify(logger.warn.mock.calls.at(-1));
      expect(warning).not.toContain(LICENSE_NUMBER);
    });

    it("still emails when retry scheduling fails", async () => {
      queue.add.mockRejectedValue(new Error("redis down"));
      await service.bindChauffeurLicense(tx(), VERIFICATION_ID, LICENSE_NUMBER);
      database.verificationIntervention.findUnique.mockResolvedValueOnce({
        id: INTERVENTION_ID,
        status: VerificationInterventionStatus.OPEN,
        kind: VerificationInterventionKind.CHAUFFEUR_DRIVERS_LICENSE,
        createdAt: OPENED_AT,
        retryAttempt: 0,
        emailNotifiedAt: null,
      });

      await service.dispatchIntervention(INTERVENTION_ID);

      expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalled();
    });

    it.each([
      ["approved", ChauffeurVerificationStatus.APPROVED, VerificationDecisionStatus.PENDING],
      [
        "already decided",
        ChauffeurVerificationStatus.IDENTITY_VERIFIED,
        VerificationDecisionStatus.APPROVED,
      ],
      ["missing", null, null],
    ] as const)(
      "does not open a face task for an %s chauffeur",
      async (_label, status, faceDecision) => {
        database.chauffeurVerification.findUnique.mockResolvedValueOnce(
          status ? { status, faceDecision } : null,
        );

        await expect(service.openChauffeurFace(VERIFICATION_ID)).resolves.toBeNull();

        expectRowLock(
          database.$queryRaw.mock.calls[0][0],
          "ChauffeurVerification",
          VERIFICATION_ID,
        );
        expect(database.verificationIntervention.upsert).not.toHaveBeenCalled();
        expect(database.chauffeurVerification.update).not.toHaveBeenCalled();
        expect(queue.add).not.toHaveBeenCalled();
        expect(emailService.sendEmail).not.toHaveBeenCalled();
      },
    );

    it("does not dispatch a terminal intervention", async () => {
      database.verificationIntervention.findUnique.mockResolvedValueOnce({
        id: INTERVENTION_ID,
        status: VerificationInterventionStatus.REJECTED,
        retryAttempt: 2,
        emailNotifiedAt: OPENED_AT,
        createdAt: OPENED_AT,
      });

      await service.dispatchIntervention(INTERVENTION_ID);

      expect(queue.add).not.toHaveBeenCalled();
      expect(emailService.sendEmail).not.toHaveBeenCalled();
    });

    it("repairs missing retries and a failed email, and stops after the final attempt", async () => {
      database.verificationIntervention.findMany.mockResolvedValueOnce([
        {
          id: INTERVENTION_ID,
          kind: VerificationInterventionKind.CHAUFFEUR_FACE,
          createdAt: OPENED_AT,
          retryAttempt: 0,
          emailNotifiedAt: null,
        },
      ]);

      await service.repairOpenInterventionDispatch();

      expect(queue.add).toHaveBeenCalledTimes(2);
      expect(emailService.sendEmail).toHaveBeenCalledTimes(1);

      queue.add.mockClear();
      emailService.sendEmail.mockClear();
      database.verificationIntervention.findMany.mockResolvedValueOnce([
        {
          id: INTERVENTION_ID,
          kind: VerificationInterventionKind.CHAUFFEUR_FACE,
          createdAt: OPENED_AT,
          retryAttempt: 2,
          emailNotifiedAt: OPENED_AT,
        },
      ]);

      await service.repairOpenInterventionDispatch();

      expect(queue.add).not.toHaveBeenCalled();
      expect(emailService.sendEmail).not.toHaveBeenCalled();
    });
  });

  describe("retry", () => {
    it("ignores an attempt past the final retry and a lost claim", async () => {
      await service.retry(INTERVENTION_ID, 3);
      expect(database.verificationIntervention.updateMany).not.toHaveBeenCalled();

      const encryptedPayload = await captureLicensePayload();
      database.verificationIntervention.findUnique.mockResolvedValue({
        id: INTERVENTION_ID,
        kind: VerificationInterventionKind.CHAUFFEUR_DRIVERS_LICENSE,
        status: VerificationInterventionStatus.OPEN,
        encryptedPayload,
        chauffeurVerificationId: VERIFICATION_ID,
        retryAttempt: 0,
        lastAttemptAt: null,
        chauffeurVerification: {
          identityFirstName: "ADA",
          identityLastName: "LOVELACE",
          dateOfBirth: DATE_OF_BIRTH,
        },
      });
      database.verificationIntervention.updateMany.mockResolvedValueOnce({ count: 0 });

      await service.retry(INTERVENTION_ID, 1);

      expect(licenseLookup.lookup).not.toHaveBeenCalled();
      expect(database.verificationIntervention.updateMany).toHaveBeenCalledWith({
        where: {
          id: INTERVENTION_ID,
          status: VerificationInterventionStatus.OPEN,
          retryAttempt: { lt: 1 },
        },
        data: { retryAttempt: 1, lastAttemptAt: OPENED_AT },
      });
    });

    it("auto-resolves a matching chauffeur licence and activates once", async () => {
      const encryptedPayload = await captureLicensePayload();
      database.verificationIntervention.findUnique.mockResolvedValue({
        id: INTERVENTION_ID,
        kind: VerificationInterventionKind.CHAUFFEUR_DRIVERS_LICENSE,
        status: VerificationInterventionStatus.OPEN,
        encryptedPayload,
        chauffeurVerificationId: VERIFICATION_ID,
        accountVerificationId: null,
        retryAttempt: 1,
        chauffeurVerification: {
          identityFirstName: "Ada",
          identityLastName: "Lovelace",
          dateOfBirth: DATE_OF_BIRTH,
          selfieObjectKey: "selfie-key",
        },
        accountVerification: null,
      });
      licenseLookup.lookup.mockResolvedValueOnce(matchingLicense);

      await service.retry(INTERVENTION_ID, 1);

      expect(database.verificationIntervention.updateMany).toHaveBeenCalledWith({
        where: { id: INTERVENTION_ID, status: VerificationInterventionStatus.OPEN },
        data: expect.objectContaining({
          status: VerificationInterventionStatus.AUTO_RESOLVED,
          encryptedPayload: null,
          resolutionSource: "PROVIDER_RETRY",
        }),
      });
      expect(database.chauffeurVerification.update).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID },
        data: expect.objectContaining({
          driversLicenseDecision: VerificationDecisionStatus.APPROVED,
          driversLicenseProviderRef: "lic-ref",
        }),
      });
      expect(activation.activateIfEligible).toHaveBeenCalledTimes(1);
      expect(activation.activateIfEligible).toHaveBeenCalledWith(VERIFICATION_ID);
    });

    it("does not activate when a concurrent resolution wins the claim", async () => {
      const encryptedPayload = await captureLicensePayload();
      database.verificationIntervention.findUnique.mockResolvedValue({
        id: INTERVENTION_ID,
        kind: VerificationInterventionKind.CHAUFFEUR_DRIVERS_LICENSE,
        status: VerificationInterventionStatus.OPEN,
        encryptedPayload,
        chauffeurVerificationId: VERIFICATION_ID,
        chauffeurVerification: {
          identityFirstName: "ADA",
          identityLastName: "LOVELACE",
          dateOfBirth: DATE_OF_BIRTH,
        },
      });
      licenseLookup.lookup.mockResolvedValueOnce(matchingLicense);
      database.verificationIntervention.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });

      await service.retry(INTERVENTION_ID, 1);

      expect(activation.activateIfEligible).not.toHaveBeenCalled();
      expect(database.chauffeurVerification.update).not.toHaveBeenCalled();
    });

    it.each([
      ["identity mismatch", { ...matchingLicense, firstName: "OTHER" }, "IDENTITY_MISMATCH"],
      [
        "expiry",
        { ...matchingLicense, expiresAt: new Date(Date.UTC(2026, 8, 25)) },
        "LICENSE_EXPIRED",
      ],
    ] as const)(
      "rejects a retried licence for %s and purges the selfie",
      async (_label, license, reason) => {
        const encryptedPayload = await captureLicensePayload();
        database.chauffeurVerification.findUnique.mockResolvedValue({
          selfieObjectKey: "selfie-key",
        });
        database.verificationIntervention.findUnique.mockResolvedValue({
          id: INTERVENTION_ID,
          kind: VerificationInterventionKind.CHAUFFEUR_DRIVERS_LICENSE,
          status: VerificationInterventionStatus.OPEN,
          encryptedPayload,
          chauffeurVerificationId: VERIFICATION_ID,
          chauffeurVerification: {
            identityFirstName: "ADA",
            identityLastName: "LOVELACE",
            dateOfBirth: DATE_OF_BIRTH,
            selfieObjectKey: "selfie-key",
          },
        });
        licenseLookup.lookup.mockResolvedValueOnce(license);

        await service.retry(INTERVENTION_ID, 1);

        expect(database.verificationIntervention.updateMany).toHaveBeenCalledWith({
          where: { id: INTERVENTION_ID, status: VerificationInterventionStatus.OPEN },
          data: expect.objectContaining({
            status: VerificationInterventionStatus.REJECTED,
            encryptedPayload: null,
            resolutionNotes: reason,
          }),
        });
        expect(storageService.deleteObjectByKey).toHaveBeenCalledWith("selfie-key");
        expect(activation.activateIfEligible).not.toHaveBeenCalled();
      },
    );

    it("rejects a definitive provider rejection and leaves an outage open", async () => {
      const encryptedPayload = await captureLicensePayload();
      const openIntervention = {
        id: INTERVENTION_ID,
        kind: VerificationInterventionKind.CHAUFFEUR_DRIVERS_LICENSE,
        status: VerificationInterventionStatus.OPEN,
        encryptedPayload,
        chauffeurVerificationId: VERIFICATION_ID,
        retryAttempt: 1,
        chauffeurVerification: {
          identityFirstName: "ADA",
          identityLastName: "LOVELACE",
          dateOfBirth: DATE_OF_BIRTH,
          selfieObjectKey: null,
        },
      };
      database.verificationIntervention.findUnique.mockResolvedValue(openIntervention);
      database.chauffeurVerification.findUnique.mockResolvedValue({ selfieObjectKey: null });
      licenseLookup.lookup.mockRejectedValueOnce(new PremblyError("REJECTED"));

      await service.retry(INTERVENTION_ID, 1);

      expect(database.verificationIntervention.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ resolutionNotes: "PROVIDER_REJECTED" }),
        }),
      );

      database.verificationIntervention.updateMany.mockClear();
      licenseLookup.lookup.mockRejectedValueOnce(new MonoError("UNAVAILABLE"));
      await service.retry(INTERVENTION_ID, 2);
      expect(
        database.verificationIntervention.updateMany.mock.calls.some(
          (call) => call[0].data?.status === VerificationInterventionStatus.REJECTED,
        ),
      ).toBe(false);
      expect(logger.warn).toHaveBeenCalled();
      expect(JSON.stringify(logger.warn.mock.calls.at(-1))).not.toContain(LICENSE_NUMBER);
    });

    it("terminates corrupt licence evidence without consuming a retry attempt", async () => {
      database.verificationIntervention.findUnique.mockResolvedValue({
        id: INTERVENTION_ID,
        kind: VerificationInterventionKind.CHAUFFEUR_DRIVERS_LICENSE,
        status: VerificationInterventionStatus.OPEN,
        encryptedPayload: "not-a-payload",
        chauffeurVerificationId: VERIFICATION_ID,
        retryAttempt: 0,
        chauffeurVerification: {
          identityFirstName: "ADA",
          identityLastName: "LOVELACE",
          dateOfBirth: DATE_OF_BIRTH,
        },
      });
      database.chauffeurVerification.findUnique.mockResolvedValue({
        status: ChauffeurVerificationStatus.IDENTITY_VERIFIED,
        selfieObjectKey: "selfie-key",
      });

      await expect(service.retry(INTERVENTION_ID, 1)).rejects.toBeInstanceOf(
        InterventionNotFoundException,
      );

      expect(licenseLookup.lookup).not.toHaveBeenCalled();
      expect(consumedRetryAttempt()).toBe(false);
      expectRowLock(database.$queryRaw.mock.calls[0][0], "ChauffeurVerification", VERIFICATION_ID);
      expect(database.verificationIntervention.updateMany).toHaveBeenCalledWith({
        where: { id: INTERVENTION_ID, status: VerificationInterventionStatus.OPEN },
        data: expect.objectContaining({
          status: VerificationInterventionStatus.REJECTED,
          encryptedPayload: null,
          resolutionSource: "EVIDENCE_CORRUPTED",
          resolutionNotes: "EVIDENCE_CORRUPTED",
        }),
      });
      expect(storageService.deleteObjectByKey).toHaveBeenCalledWith("selfie-key");
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain("not-a-payload");
    });

    it("does not mutate an approved chauffeur when licence evidence is corrupt", async () => {
      database.verificationIntervention.findUnique.mockResolvedValue({
        id: INTERVENTION_ID,
        kind: VerificationInterventionKind.CHAUFFEUR_DRIVERS_LICENSE,
        status: VerificationInterventionStatus.OPEN,
        encryptedPayload: "not-a-payload",
        chauffeurVerificationId: VERIFICATION_ID,
        chauffeurVerification: {
          identityFirstName: "ADA",
          identityLastName: "LOVELACE",
          dateOfBirth: DATE_OF_BIRTH,
        },
      });
      database.chauffeurVerification.findUnique.mockResolvedValue({
        status: ChauffeurVerificationStatus.APPROVED,
        selfieObjectKey: "selfie-key",
      });

      await expect(service.retry(INTERVENTION_ID, 1)).resolves.toBeUndefined();

      expect(consumedRetryAttempt()).toBe(false);
      expect(database.chauffeurVerification.update).not.toHaveBeenCalled();
      expect(storageService.deleteObjectByKey).not.toHaveBeenCalled();
      expect(database.verificationIntervention.updateMany).toHaveBeenCalledWith({
        where: { id: INTERVENTION_ID, status: VerificationInterventionStatus.OPEN },
        data: expect.objectContaining({
          status: VerificationInterventionStatus.AUTO_RESOLVED,
          encryptedPayload: null,
          resolutionSource: "ALREADY_APPROVED",
        }),
      });
    });

    it("releases the retry claim when the provider call fails unexpectedly", async () => {
      const encryptedPayload = await captureLicensePayload();
      database.verificationIntervention.findUnique.mockResolvedValue({
        id: INTERVENTION_ID,
        kind: VerificationInterventionKind.CHAUFFEUR_DRIVERS_LICENSE,
        status: VerificationInterventionStatus.OPEN,
        encryptedPayload,
        chauffeurVerificationId: VERIFICATION_ID,
        retryAttempt: 0,
        lastAttemptAt: null,
        chauffeurVerification: {
          identityFirstName: "ADA",
          identityLastName: "LOVELACE",
          dateOfBirth: DATE_OF_BIRTH,
        },
      });
      licenseLookup.lookup.mockRejectedValueOnce(new Error("socket hang up"));

      await expect(service.retry(INTERVENTION_ID, 1)).rejects.toThrow("socket hang up");

      const claim = database.verificationIntervention.updateMany.mock.calls.find((call) => {
        const argument = call[0] as { data?: { retryAttempt?: number; lastAttemptAt?: Date } };
        return argument.data?.retryAttempt === 1;
      });
      const claimedAt = (claim?.[0] as { data?: { lastAttemptAt?: Date } } | undefined)?.data
        ?.lastAttemptAt;
      expect(claimedAt).toBeInstanceOf(Date);
      expect(database.verificationIntervention.updateMany).toHaveBeenCalledWith({
        where: {
          id: INTERVENTION_ID,
          status: VerificationInterventionStatus.OPEN,
          retryAttempt: 1,
          lastAttemptAt: claimedAt,
        },
        data: { retryAttempt: 0, lastAttemptAt: null },
      });
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain(LICENSE_NUMBER);
    });

    it("auto-resolves an owner-driver licence and approves the account", async () => {
      freezeOpenedAt();
      await service.bindOwnerLicense(tx(), ACCOUNT_ID, DOCUMENT_ID, LICENSE_NUMBER);
      const encryptedPayload = database.verificationIntervention.upsert.mock.calls[0][0].create
        .encryptedPayload as string;
      database.verificationIntervention.findUnique.mockResolvedValue({
        id: INTERVENTION_ID,
        kind: VerificationInterventionKind.OWNER_DRIVER_LICENSE,
        status: VerificationInterventionStatus.OPEN,
        encryptedPayload,
        chauffeurVerificationId: null,
        accountVerificationId: ACCOUNT_ID,
        accountVerification: {
          identityFirstName: "ADA",
          identityLastName: "LOVELACE",
          identityDateOfBirth: DATE_OF_BIRTH,
        },
      });
      database.fleetOwnerAccountVerification.findUnique.mockResolvedValue({
        id: ACCOUNT_ID,
        userId: USER_ID,
        status: AccountVerificationStatus.REVIEW_REQUIRED,
        identityRequiresReview: false,
        bankNameMatch: NameMatchStatus.MATCHED,
      });
      licenseLookup.lookup.mockResolvedValueOnce(matchingLicense);

      await service.retry(INTERVENTION_ID, 2);

      expect(database.fleetOwnerAccountVerification.update).toHaveBeenCalledWith({
        where: { id: ACCOUNT_ID },
        data: expect.objectContaining({
          driversLicenseDecision: VerificationDecisionStatus.APPROVED,
        }),
      });
      expect(database.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: expect.objectContaining({ fleetOwnerStatus: FleetOwnerStatus.APPROVED }),
      });
      expect(activation.activateIfEligible).not.toHaveBeenCalled();
    });

    it("does not approve an owner account that still needs another review", async () => {
      freezeOpenedAt();
      await service.bindOwnerLicense(tx(), ACCOUNT_ID, DOCUMENT_ID, LICENSE_NUMBER);
      const encryptedPayload = database.verificationIntervention.upsert.mock.calls[0][0].create
        .encryptedPayload as string;
      database.verificationIntervention.findUnique.mockResolvedValue({
        id: INTERVENTION_ID,
        kind: VerificationInterventionKind.OWNER_DRIVER_LICENSE,
        status: VerificationInterventionStatus.OPEN,
        encryptedPayload,
        accountVerificationId: ACCOUNT_ID,
        accountVerification: {
          identityFirstName: "ADA",
          identityLastName: "LOVELACE",
          identityDateOfBirth: DATE_OF_BIRTH,
        },
      });
      database.fleetOwnerAccountVerification.findUnique.mockResolvedValue({
        id: ACCOUNT_ID,
        status: AccountVerificationStatus.REVIEW_REQUIRED,
        identityRequiresReview: true,
        bankNameMatch: NameMatchStatus.MATCHED,
      });
      licenseLookup.lookup.mockResolvedValueOnce(matchingLicense);

      await service.retry(INTERVENTION_ID, 1);

      expect(database.user.update).not.toHaveBeenCalled();
    });
  });

  describe("Smile results", () => {
    function faceIntervention(
      status: VerificationInterventionStatus = VerificationInterventionStatus.OPEN,
    ) {
      return {
        id: INTERVENTION_ID,
        kind: VerificationInterventionKind.CHAUFFEUR_FACE,
        status,
        chauffeurVerificationId: VERIFICATION_ID,
        resourceKey: `chauffeur-face:${VERIFICATION_ID}`,
      };
    }

    it("approves a clear comparison and activates", async () => {
      database.verificationIntervention.findUnique.mockResolvedValue(faceIntervention());

      await service.recordSmileResult(VERIFICATION_ID, "clear");

      expect(database.chauffeurVerification.update).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID },
        data: { faceDecision: VerificationDecisionStatus.APPROVED },
      });
      expect(activation.activateIfEligible).toHaveBeenCalledTimes(1);
    });

    it("approves the face directly when no intervention was opened", async () => {
      database.verificationIntervention.findUnique.mockResolvedValueOnce(null);

      await service.recordSmileResult(VERIFICATION_ID, "clear");

      expect(database.chauffeurVerification.update).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID },
        data: { faceDecision: VerificationDecisionStatus.APPROVED },
      });
      expect(activation.activateIfEligible).toHaveBeenCalledWith(VERIFICATION_ID);
    });

    it("does not activate again when the clear result was already applied", async () => {
      database.verificationIntervention.findUnique.mockResolvedValueOnce(
        faceIntervention(VerificationInterventionStatus.AUTO_RESOLVED),
      );
      database.verificationIntervention.updateMany.mockResolvedValueOnce({ count: 0 });

      await service.recordSmileResult(VERIFICATION_ID, "clear");

      expect(activation.activateIfEligible).not.toHaveBeenCalled();
      expect(database.chauffeurVerification.update).not.toHaveBeenCalled();
    });

    it("does not throw when a provider clear loses the resolution race", async () => {
      database.verificationIntervention.findUnique.mockResolvedValue(faceIntervention());
      database.verificationIntervention.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(service.recordSmileResult(VERIFICATION_ID, "clear")).resolves.toBeUndefined();
      expect(activation.activateIfEligible).not.toHaveBeenCalled();
    });

    it("rejects and purges evidence when Smile blocks", async () => {
      database.verificationIntervention.findUnique.mockResolvedValue(faceIntervention());
      database.chauffeurVerification.findUnique.mockResolvedValue({
        selfieObjectKey: "selfie-key",
      });

      await service.recordSmileResult(VERIFICATION_ID, "block");

      expect(database.chauffeurVerification.update).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID },
        data: expect.objectContaining({
          faceDecision: VerificationDecisionStatus.REJECTED,
          selfieObjectKey: null,
          identityOfficialPhoto: null,
          livenessProviderRef: null,
        }),
      });
      expect(storageService.deleteObjectByKey).toHaveBeenCalledWith("selfie-key");
      expect(activation.activateIfEligible).not.toHaveBeenCalled();
    });

    it.each(["attention", "error"] as const)(
      "opens staff face review for %s and keeps stored evidence",
      async (status) => {
        await service.recordSmileResult(VERIFICATION_ID, status);

        expect(database.verificationIntervention.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { resourceKey: `chauffeur-face:${VERIFICATION_ID}` },
            create: expect.objectContaining({
              kind: VerificationInterventionKind.CHAUFFEUR_FACE,
            }),
          }),
        );
        expect(database.chauffeurVerification.update).not.toHaveBeenCalled();
        expect(storageService.deleteObjectByKey).not.toHaveBeenCalled();
      },
    );

    it("leaves a face retry open when Smile is unavailable", async () => {
      database.verificationIntervention.findUnique.mockResolvedValue({
        ...faceIntervention(),
        retryAttempt: 0,
        lastAttemptAt: null,
        chauffeurVerification: { livenessProviderRef: "job-1" },
      });
      smileIdService.comparisonStatus.mockRejectedValueOnce(new SmileIdError("UNAVAILABLE"));

      await service.retry(INTERVENTION_ID, 1);

      expect(logger.warn).toHaveBeenCalled();
      expect(database.chauffeurVerification.update).not.toHaveBeenCalled();
      expect(database.verificationIntervention.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: { retryAttempt: 0, lastAttemptAt: null },
        }),
      );
    });

    it("releases a face retry claim when Smile fails outside the provider contract", async () => {
      database.verificationIntervention.findUnique.mockResolvedValue({
        ...faceIntervention(),
        retryAttempt: 0,
        lastAttemptAt: null,
        chauffeurVerification: { livenessProviderRef: "job-1" },
      });
      smileIdService.comparisonStatus.mockRejectedValueOnce(new Error("socket hang up"));

      await expect(service.retry(INTERVENTION_ID, 1)).rejects.toThrow("socket hang up");

      const claim = database.verificationIntervention.updateMany.mock.calls.find((call) => {
        const argument = call[0] as { data?: { retryAttempt?: number; lastAttemptAt?: Date } };
        return argument.data?.retryAttempt === 1;
      });
      const claimedAt = (claim?.[0] as { data?: { lastAttemptAt?: Date } } | undefined)?.data
        ?.lastAttemptAt;
      expect(claimedAt).toBeInstanceOf(Date);
      expect(database.verificationIntervention.updateMany).toHaveBeenCalledWith({
        where: {
          id: INTERVENTION_ID,
          status: VerificationInterventionStatus.OPEN,
          retryAttempt: 1,
          lastAttemptAt: claimedAt,
        },
        data: { retryAttempt: 0, lastAttemptAt: null },
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
        hasSelfie: false,
        hasNinPortrait: false,
        document: null,
        retryAttempt: 1,
        createdAt: OPENED_AT,
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(LICENSE_NUMBER);
      expect(serialized).not.toContain("secret-selfie-key");
      expect(serialized).not.toContain("secret-photo-bytes");
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
      expect(storageService.deleteObjectByKey).toHaveBeenCalledWith("selfie-key");

      database.verificationIntervention.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.reject(INTERVENTION_ID, USER_ID, "Again")).rejects.toBeInstanceOf(
        InterventionAlreadyResolvedException,
      );
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
      expect(database.verificationIntervention.update).toHaveBeenCalledWith({
        where: { id: INTERVENTION_ID },
        data: expect.objectContaining({
          status: VerificationInterventionStatus.AUTO_RESOLVED,
          resolutionSource: "ALREADY_APPROVED",
        }),
      });
      expect(database.verificationIntervention.updateMany).toHaveBeenCalledWith({
        where: { id: INTERVENTION_ID, status: VerificationInterventionStatus.OPEN },
        data: expect.objectContaining({
          status: VerificationInterventionStatus.AUTO_RESOLVED,
          encryptedPayload: null,
          resolutionSource: "ALREADY_APPROVED",
        }),
      });
      const locks = database.$queryRaw.mock.calls.map((call) => call[0]);
      expect(locks).toHaveLength(2);
      for (const lock of locks) {
        expectRowLock(lock, "ChauffeurVerification", VERIFICATION_ID);
      }
    });

    it("approves the linked owner licence document and the account together", async () => {
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
      });

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
      expect(database.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: expect.objectContaining({
          hasOnboarded: true,
          fleetOwnerStatus: FleetOwnerStatus.APPROVED,
        }),
      });
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
  });
});
