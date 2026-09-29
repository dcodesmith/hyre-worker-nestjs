import { Test, type TestingModule } from "@nestjs/testing";
import {
  ChauffeurApprovalStatus,
  ChauffeurVerificationStage,
  ChauffeurVerificationStatus,
  ProviderVerificationStatus,
  VerificationDecisionStatus,
} from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { USER } from "../auth/auth.const";
import { ChauffeurErrorCode } from "../chauffeur/chauffeur.error";
import { DatabaseService } from "../database/database.service";
import { StorageService } from "../storage/storage.service";
import { ChauffeurActivationService } from "./chauffeur-activation.service";

const VERIFICATION_ID = "018f47a2-7b3c-7d4e-8f90-1234567894a1";
const OWNER_ID = "018f47a2-7b3c-7d4e-8f90-1234567894b1";
const SELFIE_KEY = "fleet/selfie.webp";

type RawQuery = { strings: readonly string[]; values: readonly unknown[] };

function queryText(query: unknown): string {
  if (query && typeof query === "object" && "strings" in query && Array.isArray(query.strings)) {
    return (query as RawQuery).strings.join("");
  }
  throw new Error("Expected a Prisma.sql lock query");
}

function queryValues(query: unknown): readonly unknown[] {
  if (query && typeof query === "object" && "values" in query && Array.isArray(query.values)) {
    return (query as RawQuery).values;
  }
  throw new Error("Expected a Prisma.sql lock query");
}

function verification(overrides: Record<string, unknown> = {}) {
  return {
    id: VERIFICATION_ID,
    fleetOwnerId: OWNER_ID,
    email: "ada@example.com",
    phoneNumber: "+2348012345678",
    phoneVerifiedAt: new Date("2026-09-01T02:00:00Z"),
    termsAcceptedAt: new Date("2026-09-01T01:00:00Z"),
    privacyAcceptedAt: new Date("2026-09-01T01:00:00Z"),
    identityFirstName: "ADA",
    identityMiddleName: null,
    identityLastName: "LOVELACE",
    driversLicenseDecision: VerificationDecisionStatus.APPROVED,
    faceDecision: VerificationDecisionStatus.APPROVED,
    dateOfBirth: new Date(Date.UTC(1990, 0, 1)),
    selfieObjectKey: SELFIE_KEY,
    status: ChauffeurVerificationStatus.IDENTITY_VERIFIED,
    ...overrides,
  };
}

describe("ChauffeurActivationService", () => {
  let service: ChauffeurActivationService;
  let logger: { warn: ReturnType<typeof vi.fn> };
  let database: {
    chauffeurVerification: Record<string, ReturnType<typeof vi.fn>>;
    chauffeurVerificationStageRequest: Record<string, ReturnType<typeof vi.fn>>;
    verificationIntervention: Record<string, ReturnType<typeof vi.fn>>;
    user: Record<string, ReturnType<typeof vi.fn>>;
    $queryRaw: ReturnType<typeof vi.fn>;
    $transaction: ReturnType<typeof vi.fn>;
  };
  let storageService: {
    deleteObjectByKey: ReturnType<typeof vi.fn>;
    promotePrivateImage: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    database = {
      chauffeurVerification: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      chauffeurVerificationStageRequest: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      verificationIntervention: {
        count: vi.fn().mockResolvedValue(0),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      user: {
        findFirst: vi.fn().mockResolvedValue(null),
        findUnique: vi.fn(),
        create: vi.fn().mockResolvedValue({ id: "new-user" }),
        update: vi.fn().mockResolvedValue({ id: "existing-user" }),
      },
      $queryRaw: vi.fn().mockImplementation((query: unknown) => {
        const text = queryText(query);
        const id = queryValues(query)[0];
        if (text === 'SELECT id FROM "ChauffeurVerification" WHERE id = ::uuid FOR UPDATE') {
          return [{ id }];
        }
        if (text === 'SELECT id FROM "User" WHERE id =  FOR UPDATE') {
          return [{ id }];
        }
        throw new Error(`Unexpected activation lock query: ${text}`);
      }),
      $transaction: vi.fn(),
    };
    database.$transaction.mockImplementation(async (callback: (tx: typeof database) => unknown) =>
      callback(database),
    );
    storageService = {
      deleteObjectByKey: vi.fn().mockResolvedValue(undefined),
      promotePrivateImage: vi.fn().mockResolvedValue({
        key: "profile-key",
        url: "https://cdn.example/profile.webp",
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChauffeurActivationService,
        { provide: DatabaseService, useValue: database },
        { provide: StorageService, useValue: storageService },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get(ChauffeurActivationService);
    logger = module.get(PinoLogger);
  });

  it.each([
    ["licence", { driversLicenseDecision: VerificationDecisionStatus.PENDING }],
    ["face", { faceDecision: VerificationDecisionStatus.PENDING }],
  ] as const)(
    "does not activate when only the %s decision is approved",
    async (_label, override) => {
      database.chauffeurVerification.findUnique.mockResolvedValueOnce(verification(override));

      await expect(service.activateIfEligible(VERIFICATION_ID)).resolves.toBe(false);
      expect(database.user.create).not.toHaveBeenCalled();
      expect(database.verificationIntervention.count).not.toHaveBeenCalled();
      expect(storageService.deleteObjectByKey).not.toHaveBeenCalled();
    },
  );

  it("does not activate while a chauffeur licence or face intervention is open", async () => {
    database.chauffeurVerification.findUnique.mockResolvedValueOnce(verification());
    database.verificationIntervention.count.mockResolvedValueOnce(1);

    await expect(service.activateIfEligible(VERIFICATION_ID)).resolves.toBe(false);

    expect(database.verificationIntervention.count).toHaveBeenCalledWith({
      where: {
        chauffeurVerificationId: VERIFICATION_ID,
        status: "OPEN",
        kind: { in: ["CHAUFFEUR_DRIVERS_LICENSE", "CHAUFFEUR_FACE"] },
      },
    });
    expect(database.user.findFirst).not.toHaveBeenCalled();
    expect(database.user.create).not.toHaveBeenCalled();
    expect(storageService.deleteObjectByKey).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", null, ChauffeurErrorCode.OPERATION_FAILED],
    [
      "underage",
      new Date(
        Date.UTC(
          new Date().getUTCFullYear() - 20,
          new Date().getUTCMonth(),
          new Date().getUTCDate(),
        ),
      ),
      ChauffeurErrorCode.MINIMUM_AGE_NOT_MET,
    ],
  ] as const)(
    "fails closed for a %s stored date of birth and records a terminal driving stage",
    async (_label, dateOfBirth, reason) => {
      database.chauffeurVerification.findUnique.mockResolvedValueOnce(
        verification({ dateOfBirth }),
      );

      await expect(service.activateIfEligible(VERIFICATION_ID)).resolves.toBe(false);

      expect(database.user.create).not.toHaveBeenCalled();
      expect(database.user.update).not.toHaveBeenCalled();
      expect(database.verificationIntervention.count).not.toHaveBeenCalled();
      expect(database.chauffeurVerification.update).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID },
        data: {
          driversLicenseDecision: VerificationDecisionStatus.REJECTED,
          livenessProviderRef: null,
          selfieObjectKey: null,
          identityOfficialPhoto: null,
        },
      });
      expect(database.chauffeurVerificationStageRequest.updateMany).toHaveBeenCalledWith({
        where: {
          verificationId: VERIFICATION_ID,
          stage: ChauffeurVerificationStage.DRIVING,
          status: ProviderVerificationStatus.PROCESSING,
        },
        data: {
          status: ProviderVerificationStatus.FAILED,
          failureReason: reason,
        },
      });
      expect(database.verificationIntervention.updateMany).toHaveBeenCalledWith({
        where: { chauffeurVerificationId: VERIFICATION_ID, status: "OPEN" },
        data: expect.objectContaining({
          status: "REJECTED",
          encryptedPayload: null,
          resolutionSource: reason,
          resolutionNotes: reason,
        }),
      });
      expect(storageService.deleteObjectByKey).toHaveBeenCalledWith(SELFIE_KEY);
    },
  );

  it("creates the chauffeur once both decisions are approved and purges the selfie", async () => {
    database.chauffeurVerification.findUnique.mockResolvedValueOnce(verification());

    await expect(service.activateIfEligible(VERIFICATION_ID)).resolves.toBe(true);

    expect(queryText(database.$queryRaw.mock.calls[0][0])).toBe(
      'SELECT id FROM "ChauffeurVerification" WHERE id = ::uuid FOR UPDATE',
    );
    expect(queryValues(database.$queryRaw.mock.calls[0][0])).toEqual([VERIFICATION_ID]);
    expect(database.verificationIntervention.count).toHaveBeenCalledWith({
      where: {
        chauffeurVerificationId: VERIFICATION_ID,
        status: "OPEN",
        kind: { in: ["CHAUFFEUR_DRIVERS_LICENSE", "CHAUFFEUR_FACE"] },
      },
    });
    expect(database.user.create).toHaveBeenCalledTimes(1);
    const created = database.user.create.mock.calls[0][0].data;
    expect(created).toEqual(
      expect.objectContaining({
        email: "ada@example.com",
        name: "ADA LOVELACE",
        fleetOwnerId: OWNER_ID,
        chauffeurApprovalStatus: ChauffeurApprovalStatus.APPROVED,
        hasOnboarded: true,
        roles: { connect: { name: USER } },
      }),
    );
    expect(storageService.promotePrivateImage).toHaveBeenCalledWith(
      SELFIE_KEY,
      expect.stringMatching(new RegExp(`^chauffeurs/${VERIFICATION_ID}/profile/.+\\.webp$`)),
    );
    expect(created.image).toBe("https://cdn.example/profile.webp");
    expect(database.chauffeurVerification.update).toHaveBeenCalledWith({
      where: { id: VERIFICATION_ID },
      data: expect.objectContaining({
        chauffeurId: "new-user",
        status: ChauffeurVerificationStatus.APPROVED,
        selfieObjectKey: null,
        identityOfficialPhoto: null,
      }),
    });
    expect(database.chauffeurVerificationStageRequest.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        verificationId: VERIFICATION_ID,
        status: ProviderVerificationStatus.PROCESSING,
      }),
      data: { status: ProviderVerificationStatus.SUCCEEDED, failureReason: null },
    });
    expect(storageService.deleteObjectByKey).toHaveBeenCalledWith(SELFIE_KEY);
  });

  it("activates an existing eligible user instead of creating another", async () => {
    database.chauffeurVerification.findUnique.mockResolvedValueOnce(verification());
    database.user.findFirst.mockResolvedValueOnce({ id: "existing-user" });
    database.user.findUnique.mockResolvedValueOnce({
      id: "existing-user",
      fleetOwnerId: null,
      isOwnerDriver: false,
      roles: [{ name: USER }],
    });

    await expect(service.activateIfEligible(VERIFICATION_ID)).resolves.toBe(true);

    expect(database.user.create).not.toHaveBeenCalled();
    expect(database.user.update).toHaveBeenCalledWith({
      where: { id: "existing-user" },
      data: expect.objectContaining({
        fleetOwnerId: OWNER_ID,
        chauffeurApprovalStatus: ChauffeurApprovalStatus.APPROVED,
        chauffeurDisabledAt: null,
        image: "https://cdn.example/profile.webp",
      }),
      select: { id: true },
    });
  });

  it("does not create a second chauffeur when activation already succeeded", async () => {
    database.chauffeurVerification.findUnique
      .mockResolvedValueOnce(verification())
      .mockResolvedValueOnce(
        verification({
          status: ChauffeurVerificationStatus.APPROVED,
          chauffeurId: "new-user",
          selfieObjectKey: null,
        }),
      );

    await expect(service.activateIfEligible(VERIFICATION_ID)).resolves.toBe(true);
    await expect(service.activateIfEligible(VERIFICATION_ID)).resolves.toBe(true);

    expect(database.user.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "the fleet owner",
      { id: OWNER_ID, fleetOwnerId: null, isOwnerDriver: false, roles: [{ name: USER }] },
    ],
    [
      "an owner-driver",
      { id: "other", fleetOwnerId: null, isOwnerDriver: true, roles: [{ name: USER }] },
    ],
    [
      "a user linked to another fleet",
      { id: "other", fleetOwnerId: "other-owner", isOwnerDriver: false, roles: [{ name: USER }] },
    ],
    [
      "a non-user role",
      { id: "other", fleetOwnerId: null, isOwnerDriver: false, roles: [{ name: "fleetOwner" }] },
    ],
  ] as const)("fails closed for %s and purges the selfie", async (_label, existing) => {
    database.chauffeurVerification.findUnique.mockResolvedValueOnce(verification());
    database.user.findFirst.mockResolvedValueOnce({ id: existing.id });
    database.user.findUnique.mockResolvedValueOnce(existing);

    await expect(service.activateIfEligible(VERIFICATION_ID)).resolves.toBe(false);

    expect(database.user.create).not.toHaveBeenCalled();
    expect(database.user.update).not.toHaveBeenCalled();
    expect(database.chauffeurVerification.update).toHaveBeenCalledWith({
      where: { id: VERIFICATION_ID },
      data: {
        driversLicenseDecision: VerificationDecisionStatus.REJECTED,
        faceDecision: VerificationDecisionStatus.REJECTED,
        livenessProviderRef: null,
        selfieObjectKey: null,
        identityOfficialPhoto: null,
      },
    });
    expect(database.chauffeurVerificationStageRequest.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ verificationId: VERIFICATION_ID }),
      data: {
        status: ProviderVerificationStatus.FAILED,
        failureReason: ChauffeurErrorCode.ACCOUNT_CONFLICT,
      },
    });
    expect(database.verificationIntervention.updateMany).toHaveBeenCalledWith({
      where: { chauffeurVerificationId: VERIFICATION_ID, status: "OPEN" },
      data: expect.objectContaining({
        status: "REJECTED",
        encryptedPayload: null,
        resolutionSource: ChauffeurErrorCode.ACCOUNT_CONFLICT,
        resolutionNotes: ChauffeurErrorCode.ACCOUNT_CONFLICT,
      }),
    });
    expect(storageService.deleteObjectByKey).toHaveBeenCalledWith(SELFIE_KEY);
  });

  it("logs a selfie purge failure without failing the activation", async () => {
    database.chauffeurVerification.findUnique.mockResolvedValueOnce(verification());
    storageService.deleteObjectByKey.mockRejectedValueOnce(new Error("r2 down"));

    await expect(service.activateIfEligible(VERIFICATION_ID)).resolves.toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      { verificationId: VERIFICATION_ID },
      "Failed to purge terminal chauffeur selfie",
    );
  });
});
