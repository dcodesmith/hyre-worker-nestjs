import { createHmac } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import {
  ChauffeurApprovalStatus,
  ChauffeurVerificationStage,
  ChauffeurVerificationStatus,
  Prisma,
  ProviderVerificationStatus,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { USER } from "../auth/auth.const";
import { DatabaseService } from "../database/database.service";
import { EmailService } from "../email/email.service";
import { PremblyError, PremblyService } from "../prembly/prembly.service";
import { StorageService } from "../storage/storage.service";
import {
  PhoneVerificationCodeInvalidException,
  PhoneVerificationProviderUnavailableException,
} from "../verification/account-verification.error";
import { PhoneVerificationService } from "../verification/phone-verification.service";
import {
  ChauffeurAccountConflictException,
  ChauffeurBiometricNotVerifiedException,
  ChauffeurErrorCode,
  ChauffeurIdempotencyKeyReusedException,
  ChauffeurIdentityMismatchException,
  ChauffeurInvitationExistsException,
  ChauffeurInvitationInvalidException,
  ChauffeurInvitationNotAllowedException,
  ChauffeurLicenseExpiredException,
  ChauffeurLicenseNotVerifiedException,
  ChauffeurMinimumAgeException,
  ChauffeurNinNotVerifiedException,
  ChauffeurNotFoundException,
  ChauffeurOperationFailedException,
  ChauffeurPhoneCodeInvalidException,
  ChauffeurPhoneProviderUnavailableException,
  ChauffeurProviderUnavailableException,
  ChauffeurRequestInProgressException,
  ChauffeurStepIncompleteException,
} from "./chauffeur.error";
import { ChauffeurService } from "./chauffeur.service";
import { ChauffeurImageService } from "./chauffeur-image.service";

const HMAC_KEY = "test-hmac-key";
const OWNER_ID = "owner-1";
const VERIFICATION_ID = "ver-1";
const INVITE_INPUT = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  phoneNumber: "+2348012345678",
};

const emailTemplateMocks = vi.hoisted(() => ({
  renderChauffeurInvitationEmail: vi.fn(async ({ inviteUrl }: { inviteUrl: string }) => {
    return `<a href="${inviteUrl}">Join</a>`;
  }),
}));

vi.mock("../../templates/emails", () => ({
  renderChauffeurInvitationEmail: emailTemplateMocks.renderChauffeurInvitationEmail,
}));

function hash(value: string): string {
  return createHmac("sha256", HMAC_KEY).update(value).digest("hex");
}

function uniqueConstraintError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
  });
}

function invitation(overrides: Record<string, unknown> = {}) {
  return {
    id: VERIFICATION_ID,
    fleetOwnerId: OWNER_ID,
    chauffeurId: null,
    name: INVITE_INPUT.name,
    email: INVITE_INPUT.email,
    phoneNumber: INVITE_INPUT.phoneNumber,
    invitationIdempotencyKey: hash("invite-key-1"),
    invitationRequestHash: hash(JSON.stringify(INVITE_INPUT)),
    inviteTokenHash: "hashed-token",
    inviteExpiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
    inviteAcceptedAt: null,
    sessionTokenHash: null,
    sessionExpiresAt: null,
    termsAcceptedAt: null,
    privacyAcceptedAt: null,
    phoneVerifiedAt: null,
    ninHash: null,
    ninLast4: null,
    identityFirstName: null,
    identityMiddleName: null,
    identityLastName: null,
    identityProviderRef: null,
    driversLicenseHash: null,
    driversLicenseLast4: null,
    driversLicenseExpiresAt: null,
    driversLicenseProviderRef: null,
    dateOfBirth: null,
    livenessProviderRef: null,
    livenessConfidence: null,
    faceMatchConfidence: null,
    selfieObjectKey: null,
    status: ChauffeurVerificationStatus.INVITED,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    chauffeur: null,
    fleetOwner: { name: "Fleet Owner" },
    ...overrides,
  };
}

function consented(overrides: Record<string, unknown> = {}) {
  return invitation({
    termsAcceptedAt: new Date("2026-09-01T01:00:00Z"),
    privacyAcceptedAt: new Date("2026-09-01T01:00:00Z"),
    status: ChauffeurVerificationStatus.CONSENTED,
    ...overrides,
  });
}

function phoneVerified(overrides: Record<string, unknown> = {}) {
  return consented({
    phoneVerifiedAt: new Date("2026-09-01T02:00:00Z"),
    status: ChauffeurVerificationStatus.PHONE_VERIFIED,
    ...overrides,
  });
}

function identityVerified(overrides: Record<string, unknown> = {}) {
  return phoneVerified({
    ninHash: hash("12345678901"),
    identityFirstName: "ADA",
    identityLastName: "LOVELACE",
    identityProviderRef: "nin-ref",
    status: ChauffeurVerificationStatus.IDENTITY_VERIFIED,
    ...overrides,
  });
}

const selfie = {
  mimetype: "image/jpeg",
  size: 4,
  buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
};

const SELFIE_OBJECT_KEY = `${OWNER_ID}/chauffeurs/${VERIFICATION_ID}/documents/selfie.jpg`;

const eligibleLicense = {
  licenseNumber: "ABC12345",
  firstName: "ADA",
  middleName: null,
  lastName: "LOVELACE",
  dateOfBirth: new Date(Date.UTC(1990, 0, 1)),
  expiresAt: new Date(Date.UTC(2099, 11, 31)),
  officialPhoto: "official-photo",
  reference: "lic-ref",
};

describe("ChauffeurService", () => {
  let service: ChauffeurService;
  let databaseService: {
    chauffeurVerification: Record<string, ReturnType<typeof vi.fn>>;
    chauffeurVerificationStageRequest: Record<string, ReturnType<typeof vi.fn>>;
    user: Record<string, ReturnType<typeof vi.fn>>;
    $transaction: ReturnType<typeof vi.fn>;
    $queryRaw: ReturnType<typeof vi.fn>;
  };
  let emailService: { sendEmail: ReturnType<typeof vi.fn> };
  let phoneVerificationService: {
    sendCode: ReturnType<typeof vi.fn>;
    checkCode: ReturnType<typeof vi.fn>;
  };
  let premblyService: {
    verifyNin: ReturnType<typeof vi.fn>;
    verifyDriversLicense: ReturnType<typeof vi.fn>;
    verifyFaceLiveness: ReturnType<typeof vi.fn>;
    compareFaces: ReturnType<typeof vi.fn>;
  };
  let imageService: { processSelfie: ReturnType<typeof vi.fn> };
  let storageService: {
    uploadBuffer: ReturnType<typeof vi.fn>;
    deleteObjectByKey: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    databaseService = {
      chauffeurVerification: {
        findUnique: vi.fn(),
        findUniqueOrThrow: vi.fn(),
        findFirstOrThrow: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
        deleteMany: vi.fn(),
        count: vi.fn(),
      },
      chauffeurVerificationStageRequest: {
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      user: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
        create: vi.fn(),
      },
      $queryRaw: vi.fn().mockResolvedValue([{ id: "existing-user" }]),
      $transaction: vi.fn(),
    };
    databaseService.$transaction.mockImplementation(async (arg: unknown) => {
      if (typeof arg === "function") {
        return (arg as (tx: typeof databaseService) => Promise<unknown>)(databaseService);
      }
      return Promise.all(arg as Promise<unknown>[]);
    });
    emailService = { sendEmail: vi.fn().mockResolvedValue(undefined) };
    phoneVerificationService = { sendCode: vi.fn(), checkCode: vi.fn() };
    premblyService = {
      verifyNin: vi.fn(),
      verifyDriversLicense: vi.fn(),
      verifyFaceLiveness: vi.fn(),
      compareFaces: vi.fn(),
    };
    imageService = { processSelfie: vi.fn().mockResolvedValue(Buffer.from("processed-selfie")) };
    storageService = {
      uploadBuffer: vi.fn().mockResolvedValue(SELFIE_OBJECT_KEY),
      deleteObjectByKey: vi.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChauffeurService,
        { provide: DatabaseService, useValue: databaseService },
        { provide: EmailService, useValue: emailService },
        { provide: PhoneVerificationService, useValue: phoneVerificationService },
        { provide: PremblyService, useValue: premblyService },
        { provide: ChauffeurImageService, useValue: imageService },
        { provide: StorageService, useValue: storageService },
        {
          provide: ConfigService,
          useValue: { get: vi.fn((key: string) => (key === "HMAC_KEY" ? HMAC_KEY : undefined)) },
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get(ChauffeurService);
  });

  describe("createInvitation", () => {
    it("emails the raw token and returns an owner record without it", async () => {
      databaseService.chauffeurVerification.findUnique.mockResolvedValueOnce(null);
      databaseService.user.findUnique.mockResolvedValueOnce({
        id: OWNER_ID,
        name: "Fleet Owner",
        isOwnerDriver: false,
      });
      const created = invitation();
      databaseService.chauffeurVerification.create.mockResolvedValueOnce(created);

      const result = await service.createInvitation(OWNER_ID, "invite-key-1", INVITE_INPUT);

      expect(result).toEqual({
        id: VERIFICATION_ID,
        chauffeurId: null,
        name: INVITE_INPUT.name,
        email: INVITE_INPUT.email,
        phoneNumber: INVITE_INPUT.phoneNumber,
        status: ChauffeurVerificationStatus.INVITED,
        isActive: false,
        image: null,
        invitedAt: created.createdAt,
      });
      expect(JSON.stringify(result)).not.toContain("token=");
      const createData = databaseService.chauffeurVerification.create.mock.calls[0][0].data;
      expect(createData.inviteTokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(emailService.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: INVITE_INPUT.email,
          html: expect.stringContaining("/chauffeur/onboarding?token="),
        }),
      );
      const html = emailService.sendEmail.mock.calls[0][0].html as string;
      expect(html).toMatch(/token=[A-Za-z0-9_-]+/);
    });

    it("rejects an owner-driver invitation", async () => {
      databaseService.chauffeurVerification.findUnique.mockResolvedValueOnce(null);
      databaseService.user.findUnique.mockResolvedValueOnce({
        id: OWNER_ID,
        name: "Owner Driver",
        isOwnerDriver: true,
      });

      await expect(
        service.createInvitation(OWNER_ID, "invite-key-1", INVITE_INPUT),
      ).rejects.toBeInstanceOf(ChauffeurInvitationNotAllowedException);
      expect(databaseService.chauffeurVerification.create).not.toHaveBeenCalled();
    });

    it("fails when the fleet owner no longer exists", async () => {
      databaseService.chauffeurVerification.findUnique.mockResolvedValueOnce(null);
      databaseService.user.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.createInvitation(OWNER_ID, "invite-key-1", INVITE_INPUT),
      ).rejects.toBeInstanceOf(ChauffeurOperationFailedException);
    });

    it("replays an identical idempotent invitation", async () => {
      const replay = invitation();
      databaseService.chauffeurVerification.findUnique.mockResolvedValueOnce(replay);

      await expect(
        service.createInvitation(OWNER_ID, "invite-key-1", INVITE_INPUT),
      ).resolves.toMatchObject({ id: VERIFICATION_ID, email: INVITE_INPUT.email });
      expect(databaseService.chauffeurVerification.create).not.toHaveBeenCalled();
    });

    it("rejects a reused idempotency key with different details", async () => {
      databaseService.chauffeurVerification.findUnique.mockResolvedValueOnce(
        invitation({
          invitationRequestHash: hash(JSON.stringify({ ...INVITE_INPUT, name: "Other" })),
        }),
      );

      await expect(
        service.createInvitation(OWNER_ID, "invite-key-1", INVITE_INPUT),
      ).rejects.toBeInstanceOf(ChauffeurIdempotencyKeyReusedException);
    });

    it("treats a unique email collision as an existing invitation", async () => {
      databaseService.chauffeurVerification.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      databaseService.user.findUnique.mockResolvedValueOnce({
        id: OWNER_ID,
        name: "Fleet Owner",
        isOwnerDriver: false,
      });
      databaseService.chauffeurVerification.create.mockRejectedValueOnce(uniqueConstraintError());

      await expect(
        service.createInvitation(OWNER_ID, "invite-key-1", INVITE_INPUT),
      ).rejects.toBeInstanceOf(ChauffeurInvitationExistsException);
    });

    it("rejects a second invite while the previous one is still active", async () => {
      databaseService.chauffeurVerification.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: "old-ver",
          status: ChauffeurVerificationStatus.INVITED,
          inviteAcceptedAt: null,
          inviteExpiresAt: new Date(Date.now() + 60_000),
          sessionExpiresAt: null,
        });
      databaseService.user.findUnique.mockResolvedValueOnce({
        id: OWNER_ID,
        name: "Fleet Owner",
        isOwnerDriver: false,
      });

      await expect(
        service.createInvitation(OWNER_ID, "invite-key-2", INVITE_INPUT),
      ).rejects.toBeInstanceOf(ChauffeurInvitationExistsException);
      expect(databaseService.chauffeurVerification.deleteMany).not.toHaveBeenCalled();
      expect(databaseService.chauffeurVerification.create).not.toHaveBeenCalled();
    });

    it("replaces an expired unaccepted invite when a new idempotency key is used", async () => {
      databaseService.chauffeurVerification.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: "old-ver",
          status: ChauffeurVerificationStatus.INVITED,
          inviteAcceptedAt: null,
          inviteExpiresAt: new Date(Date.now() - 1000),
          sessionExpiresAt: null,
        });
      databaseService.user.findUnique.mockResolvedValueOnce({
        id: OWNER_ID,
        name: "Fleet Owner",
        isOwnerDriver: false,
      });
      databaseService.chauffeurVerification.deleteMany.mockResolvedValueOnce({ count: 1 });
      const created = invitation({ invitationIdempotencyKey: hash("invite-key-2") });
      databaseService.chauffeurVerification.create.mockResolvedValueOnce(created);

      await expect(
        service.createInvitation(OWNER_ID, "invite-key-2", INVITE_INPUT),
      ).resolves.toMatchObject({ id: VERIFICATION_ID });
      expect(databaseService.chauffeurVerification.deleteMany).toHaveBeenCalledWith({
        where: { id: "old-ver", status: { not: ChauffeurVerificationStatus.APPROVED } },
      });
      expect(databaseService.chauffeurVerification.create).toHaveBeenCalled();
    });

    it("replaces an accepted invite after the onboarding session expires", async () => {
      databaseService.chauffeurVerification.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: "old-ver",
          status: ChauffeurVerificationStatus.CONSENTED,
          inviteAcceptedAt: new Date("2026-09-01T00:00:00Z"),
          inviteExpiresAt: new Date(Date.now() + 60_000),
          sessionExpiresAt: new Date(Date.now() - 1000),
        });
      databaseService.user.findUnique.mockResolvedValueOnce({
        id: OWNER_ID,
        name: "Fleet Owner",
        isOwnerDriver: false,
      });
      databaseService.chauffeurVerification.deleteMany.mockResolvedValueOnce({ count: 1 });
      databaseService.chauffeurVerification.create.mockResolvedValueOnce(invitation());

      await expect(
        service.createInvitation(OWNER_ID, "invite-key-2", INVITE_INPUT),
      ).resolves.toMatchObject({ id: VERIFICATION_ID });
      expect(databaseService.chauffeurVerification.deleteMany).toHaveBeenCalled();
    });

    it("rejects a fresh invite when an approved chauffeur already uses the email", async () => {
      databaseService.chauffeurVerification.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: "old-ver",
          status: ChauffeurVerificationStatus.APPROVED,
          inviteAcceptedAt: new Date(),
          inviteExpiresAt: new Date(Date.now() - 1000),
          sessionExpiresAt: new Date(Date.now() - 1000),
        });
      databaseService.user.findUnique.mockResolvedValueOnce({
        id: OWNER_ID,
        name: "Fleet Owner",
        isOwnerDriver: false,
      });

      await expect(
        service.createInvitation(OWNER_ID, "invite-key-2", INVITE_INPUT),
      ).rejects.toBeInstanceOf(ChauffeurInvitationExistsException);
      expect(databaseService.chauffeurVerification.deleteMany).not.toHaveBeenCalled();
    });

    it("deletes an unaccepted invite when email delivery fails", async () => {
      databaseService.chauffeurVerification.findUnique.mockResolvedValueOnce(null);
      databaseService.user.findUnique.mockResolvedValueOnce({
        id: OWNER_ID,
        name: "Fleet Owner",
        isOwnerDriver: false,
      });
      databaseService.chauffeurVerification.create.mockResolvedValueOnce(invitation());
      emailService.sendEmail.mockRejectedValueOnce(new Error("smtp down"));

      await expect(
        service.createInvitation(OWNER_ID, "invite-key-1", INVITE_INPUT),
      ).rejects.toThrow("smtp down");
      expect(databaseService.chauffeurVerification.deleteMany).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID, inviteAcceptedAt: null },
      });
    });
  });

  describe("list and update", () => {
    it("returns paginated owner records and compliance placeholders", async () => {
      databaseService.chauffeurVerification.findMany.mockResolvedValueOnce([invitation()]);
      databaseService.chauffeurVerification.count.mockResolvedValueOnce(1);

      const result = await service.list(OWNER_ID, { page: 1, limit: 20 });

      expect(result.items).toHaveLength(1);
      expect(result.meta).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
      expect(result.complianceRequirements).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "LASDRI", required: false }),
          expect.objectContaining({ type: "LASRRA", required: false }),
          expect.objectContaining({ type: "DRIVER_BADGE", required: false }),
        ]),
      );
    });

    it("deactivates an approved chauffeur", async () => {
      databaseService.user.updateMany.mockResolvedValueOnce({ count: 1 });
      databaseService.chauffeurVerification.findFirstOrThrow.mockResolvedValueOnce(
        invitation({
          chauffeurId: "chauffeur-1",
          status: ChauffeurVerificationStatus.APPROVED,
          chauffeur: { image: "https://cdn/x.jpg", chauffeurDisabledAt: new Date() },
        }),
      );

      await expect(
        service.update(OWNER_ID, "chauffeur-1", { isActive: false }),
      ).resolves.toMatchObject({
        chauffeurId: "chauffeur-1",
        isActive: false,
      });
      expect(databaseService.user.updateMany).toHaveBeenCalledWith({
        where: {
          id: "chauffeur-1",
          fleetOwnerId: OWNER_ID,
          chauffeurApprovalStatus: ChauffeurApprovalStatus.APPROVED,
        },
        data: { chauffeurDisabledAt: expect.any(Date) },
      });
    });

    it("throws when the chauffeur cannot be updated", async () => {
      databaseService.user.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(service.update(OWNER_ID, "missing", { isActive: false })).rejects.toBeInstanceOf(
        ChauffeurNotFoundException,
      );
    });
  });

  describe("exchangeInvitation", () => {
    it("accepts a valid token once and returns a session", async () => {
      const token = "invite-token-value-32-chars-long!!";
      databaseService.chauffeurVerification.findUnique.mockResolvedValueOnce(
        invitation({ inviteTokenHash: hash(token) }),
      );
      databaseService.chauffeurVerification.updateMany.mockResolvedValueOnce({ count: 1 });
      databaseService.chauffeurVerification.findUniqueOrThrow.mockResolvedValueOnce(
        invitation({ inviteAcceptedAt: new Date(), status: ChauffeurVerificationStatus.INVITED }),
      );

      const result = await service.exchangeInvitation(token);

      expect(result.sessionToken).toEqual(expect.any(String));
      expect(result.sessionToken.length).toBeGreaterThan(20);
      expect(result.onboarding.id).toBe(VERIFICATION_ID);
      expect(result.onboarding.phoneNumber).toBe("**********5678");
      expect(databaseService.chauffeurVerification.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: VERIFICATION_ID,
            inviteAcceptedAt: null,
            status: ChauffeurVerificationStatus.INVITED,
          }),
        }),
      );
    });

    it("rejects an already accepted, expired, or missing invitation", async () => {
      databaseService.chauffeurVerification.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.exchangeInvitation("missing-token-value-32-chars-long"),
      ).rejects.toBeInstanceOf(ChauffeurInvitationInvalidException);

      databaseService.chauffeurVerification.findUnique.mockResolvedValueOnce(
        invitation({ inviteAcceptedAt: new Date() }),
      );
      await expect(
        service.exchangeInvitation("used-token-value-32-chars-long!!!!"),
      ).rejects.toBeInstanceOf(ChauffeurInvitationInvalidException);

      databaseService.chauffeurVerification.findUnique.mockResolvedValueOnce(
        invitation({ inviteExpiresAt: new Date(Date.now() - 1000) }),
      );
      await expect(
        service.exchangeInvitation("expired-token-value-32-chars-long!"),
      ).rejects.toBeInstanceOf(ChauffeurInvitationInvalidException);
    });

    it("rejects a concurrent second exchange", async () => {
      databaseService.chauffeurVerification.findUnique.mockResolvedValueOnce(invitation());
      databaseService.chauffeurVerification.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(
        service.exchangeInvitation("race-token-value-32-chars-long!!!!"),
      ).rejects.toBeInstanceOf(ChauffeurInvitationInvalidException);
    });
  });

  describe("consent and phone", () => {
    it("records consent and is idempotent afterwards", async () => {
      databaseService.chauffeurVerification.findUniqueOrThrow
        .mockResolvedValueOnce(invitation())
        .mockResolvedValueOnce(consented());

      await expect(service.acceptConsent(VERIFICATION_ID)).resolves.toMatchObject({
        status: ChauffeurVerificationStatus.CONSENTED,
        steps: expect.objectContaining({ consent: true }),
      });
      expect(databaseService.chauffeurVerification.update).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID },
        data: expect.objectContaining({ status: ChauffeurVerificationStatus.CONSENTED }),
      });

      databaseService.chauffeurVerification.findUniqueOrThrow.mockResolvedValueOnce(consented());
      await expect(service.acceptConsent(VERIFICATION_ID)).resolves.toMatchObject({
        steps: expect.objectContaining({ consent: true }),
      });
      expect(databaseService.chauffeurVerification.update).toHaveBeenCalledTimes(1);
    });

    it("requires consent before sending or checking a phone code", async () => {
      databaseService.chauffeurVerification.findUniqueOrThrow.mockResolvedValue(invitation());

      await expect(service.sendPhoneVerification(VERIFICATION_ID)).rejects.toBeInstanceOf(
        ChauffeurStepIncompleteException,
      );
      await expect(
        service.checkPhoneVerification(VERIFICATION_ID, "123456"),
      ).rejects.toBeInstanceOf(ChauffeurStepIncompleteException);
    });

    it("sends a chauffeur-scoped code and maps Twilio outages", async () => {
      databaseService.chauffeurVerification.findUniqueOrThrow.mockResolvedValueOnce(consented());
      phoneVerificationService.sendCode.mockResolvedValueOnce({
        status: "PENDING",
        phoneNumber: "**********5678",
      });

      await expect(service.sendPhoneVerification(VERIFICATION_ID)).resolves.toEqual({
        status: "PENDING",
        phoneNumber: "**********5678",
      });
      expect(phoneVerificationService.sendCode).toHaveBeenCalledWith(
        `chauffeur:${VERIFICATION_ID}`,
        INVITE_INPUT.phoneNumber,
      );

      databaseService.chauffeurVerification.findUniqueOrThrow.mockResolvedValueOnce(consented());
      phoneVerificationService.sendCode.mockRejectedValueOnce(
        new PhoneVerificationProviderUnavailableException(),
      );
      await expect(service.sendPhoneVerification(VERIFICATION_ID)).rejects.toBeInstanceOf(
        ChauffeurPhoneProviderUnavailableException,
      );
    });

    it("returns a masked verified phone without sending again", async () => {
      databaseService.chauffeurVerification.findUniqueOrThrow.mockResolvedValueOnce(
        phoneVerified(),
      );

      await expect(service.sendPhoneVerification(VERIFICATION_ID)).resolves.toEqual({
        status: "VERIFIED",
        phoneNumber: "**********5678",
      });
      expect(phoneVerificationService.sendCode).not.toHaveBeenCalled();
    });

    it("stores phone verification and maps an invalid code", async () => {
      databaseService.chauffeurVerification.findUniqueOrThrow.mockResolvedValueOnce(consented());
      phoneVerificationService.checkCode.mockResolvedValueOnce({ status: "VERIFIED" });

      await expect(service.checkPhoneVerification(VERIFICATION_ID, "123456")).resolves.toEqual({
        status: "VERIFIED",
        phoneNumber: "**********5678",
      });
      expect(databaseService.chauffeurVerification.update).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID },
        data: {
          phoneVerifiedAt: expect.any(Date),
          status: ChauffeurVerificationStatus.PHONE_VERIFIED,
        },
      });

      databaseService.chauffeurVerification.findUniqueOrThrow.mockResolvedValueOnce(consented());
      phoneVerificationService.checkCode.mockRejectedValueOnce(
        new PhoneVerificationCodeInvalidException(),
      );
      await expect(
        service.checkPhoneVerification(VERIFICATION_ID, "000000"),
      ).rejects.toBeInstanceOf(ChauffeurPhoneCodeInvalidException);
    });
  });

  describe("verifyNin", () => {
    it("returns approved onboarding state without calling Prembly or writing stages", async () => {
      databaseService.chauffeurVerification.findUniqueOrThrow.mockResolvedValueOnce(
        identityVerified({
          status: ChauffeurVerificationStatus.APPROVED,
          chauffeurId: "chauffeur-1",
        }),
      );

      await expect(
        service.verifyNin(VERIFICATION_ID, "nin-key-1", { nin: "12345678901" }),
      ).resolves.toMatchObject({
        status: ChauffeurVerificationStatus.APPROVED,
        steps: expect.objectContaining({ driving: true }),
      });
      expect(premblyService.verifyNin).not.toHaveBeenCalled();
      expect(databaseService.chauffeurVerificationStageRequest.create).not.toHaveBeenCalled();
      expect(databaseService.chauffeurVerification.update).not.toHaveBeenCalled();
    });

    it("does not reactivate or call providers after the owner deactivates the chauffeur", async () => {
      databaseService.chauffeurVerification.findUniqueOrThrow.mockResolvedValueOnce(
        identityVerified({
          status: ChauffeurVerificationStatus.APPROVED,
          chauffeurId: "chauffeur-1",
          chauffeur: { image: null, chauffeurDisabledAt: new Date() },
        }),
      );

      await expect(
        service.verifyNin(VERIFICATION_ID, "nin-key-1", { nin: "12345678901" }),
      ).resolves.toMatchObject({ status: ChauffeurVerificationStatus.APPROVED });
      expect(premblyService.verifyNin).not.toHaveBeenCalled();
      expect(databaseService.user.update).not.toHaveBeenCalled();
      expect(databaseService.user.updateMany).not.toHaveBeenCalled();
    });

    it("requires a verified phone first", async () => {
      databaseService.chauffeurVerification.findUniqueOrThrow.mockResolvedValueOnce(consented());

      await expect(
        service.verifyNin(VERIFICATION_ID, "nin-key-1", { nin: "12345678901" }),
      ).rejects.toBeInstanceOf(ChauffeurStepIncompleteException);
    });

    it("persists identity details after Prembly succeeds", async () => {
      databaseService.chauffeurVerification.findUniqueOrThrow
        .mockResolvedValueOnce(phoneVerified())
        .mockResolvedValueOnce(identityVerified());
      databaseService.chauffeurVerificationStageRequest.findUnique.mockResolvedValueOnce(null);
      databaseService.chauffeurVerificationStageRequest.create.mockResolvedValueOnce({
        id: "stage-1",
      });
      premblyService.verifyNin.mockResolvedValueOnce({
        firstName: "ADA",
        middleName: null,
        lastName: "LOVELACE",
        reference: "nin-ref",
      });

      await expect(
        service.verifyNin(VERIFICATION_ID, "nin-key-1", { nin: "12345678901" }),
      ).resolves.toMatchObject({
        steps: expect.objectContaining({ nin: true }),
      });
      expect(databaseService.chauffeurVerification.update).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID },
        data: expect.objectContaining({
          ninLast4: "8901",
          identityFirstName: "ADA",
          identityLastName: "LOVELACE",
          status: ChauffeurVerificationStatus.IDENTITY_VERIFIED,
        }),
      });
    });

    it("maps a Prembly rejection and stores the failed stage", async () => {
      databaseService.chauffeurVerification.findUniqueOrThrow.mockResolvedValueOnce(
        phoneVerified(),
      );
      databaseService.chauffeurVerificationStageRequest.findUnique.mockResolvedValueOnce(null);
      databaseService.chauffeurVerificationStageRequest.create.mockResolvedValueOnce({
        id: "stage-1",
      });
      premblyService.verifyNin.mockRejectedValueOnce(new PremblyError("REJECTED"));

      await expect(
        service.verifyNin(VERIFICATION_ID, "nin-key-1", { nin: "12345678901" }),
      ).rejects.toBeInstanceOf(ChauffeurNinNotVerifiedException);
      expect(databaseService.chauffeurVerificationStageRequest.updateMany).toHaveBeenCalledWith({
        where: { id: "stage-1", status: ProviderVerificationStatus.PROCESSING },
        data: {
          status: ProviderVerificationStatus.FAILED,
          failureReason: ChauffeurErrorCode.NIN_NOT_VERIFIED,
        },
      });
    });

    it("replays a succeeded stage and rejects an in-progress lease", async () => {
      databaseService.chauffeurVerification.findUniqueOrThrow.mockResolvedValue(phoneVerified());
      databaseService.chauffeurVerificationStageRequest.findUnique.mockResolvedValueOnce({
        id: "stage-1",
        stage: ChauffeurVerificationStage.IDENTITY,
        requestHash: hash(JSON.stringify({ nin: "12345678901" })),
        status: ProviderVerificationStatus.SUCCEEDED,
      });

      await expect(
        service.verifyNin(VERIFICATION_ID, "nin-key-1", { nin: "12345678901" }),
      ).resolves.toMatchObject({ id: VERIFICATION_ID });
      expect(premblyService.verifyNin).not.toHaveBeenCalled();

      databaseService.chauffeurVerificationStageRequest.findUnique.mockResolvedValueOnce({
        id: "stage-1",
        stage: ChauffeurVerificationStage.IDENTITY,
        requestHash: hash(JSON.stringify({ nin: "12345678901" })),
        status: ProviderVerificationStatus.PROCESSING,
        processingExpiresAt: new Date(Date.now() + 60_000),
      });
      await expect(
        service.verifyNin(VERIFICATION_ID, "nin-key-1", { nin: "12345678901" }),
      ).rejects.toBeInstanceOf(ChauffeurRequestInProgressException);
    });

    it("rejects a reused stage key with a different NIN", async () => {
      databaseService.chauffeurVerification.findUniqueOrThrow.mockResolvedValueOnce(
        phoneVerified(),
      );
      databaseService.chauffeurVerificationStageRequest.findUnique.mockResolvedValueOnce({
        id: "stage-1",
        stage: ChauffeurVerificationStage.IDENTITY,
        requestHash: hash(JSON.stringify({ nin: "00000000000" })),
        status: ProviderVerificationStatus.SUCCEEDED,
      });

      await expect(
        service.verifyNin(VERIFICATION_ID, "nin-key-1", { nin: "12345678901" }),
      ).rejects.toBeInstanceOf(ChauffeurIdempotencyKeyReusedException);
    });

    it("replays a stored OPERATION_FAILED stage as the same exception", async () => {
      databaseService.chauffeurVerification.findUniqueOrThrow.mockResolvedValueOnce(
        phoneVerified(),
      );
      databaseService.chauffeurVerificationStageRequest.findUnique.mockResolvedValueOnce({
        id: "stage-1",
        stage: ChauffeurVerificationStage.IDENTITY,
        requestHash: hash(JSON.stringify({ nin: "12345678901" })),
        status: ProviderVerificationStatus.FAILED,
        failureReason: ChauffeurErrorCode.OPERATION_FAILED,
      });

      await expect(
        service.verifyNin(VERIFICATION_ID, "nin-key-1", { nin: "12345678901" }),
      ).rejects.toBeInstanceOf(ChauffeurOperationFailedException);
      expect(premblyService.verifyNin).not.toHaveBeenCalled();
    });
  });

  describe("verifyDriving", () => {
    async function claimDrivingStage(): Promise<void> {
      databaseService.chauffeurVerificationStageRequest.findUnique.mockResolvedValueOnce(null);
      databaseService.chauffeurVerificationStageRequest.create.mockResolvedValueOnce({
        id: "stage-drive",
      });
    }

    it("returns approved onboarding state without processing the selfie or calling providers", async () => {
      databaseService.chauffeurVerification.findUniqueOrThrow.mockResolvedValueOnce(
        identityVerified({
          status: ChauffeurVerificationStatus.APPROVED,
          chauffeurId: "chauffeur-1",
        }),
      );

      await expect(
        service.verifyDriving(
          VERIFICATION_ID,
          "drive-key-1",
          { driversLicenseNumber: "ABC12345" },
          selfie,
        ),
      ).resolves.toMatchObject({ status: ChauffeurVerificationStatus.APPROVED });
      expect(imageService.processSelfie).not.toHaveBeenCalled();
      expect(premblyService.verifyDriversLicense).not.toHaveBeenCalled();
      expect(storageService.uploadBuffer).not.toHaveBeenCalled();
      expect(databaseService.user.create).not.toHaveBeenCalled();
    });

    it("does not reactivate a deactivated approved chauffeur during driving replay", async () => {
      databaseService.chauffeurVerification.findUniqueOrThrow.mockResolvedValueOnce(
        identityVerified({
          status: ChauffeurVerificationStatus.APPROVED,
          chauffeurId: "chauffeur-1",
          chauffeur: { image: null, chauffeurDisabledAt: new Date() },
        }),
      );

      await expect(
        service.verifyDriving(
          VERIFICATION_ID,
          "drive-key-1",
          { driversLicenseNumber: "ABC12345" },
          selfie,
        ),
      ).resolves.toMatchObject({ status: ChauffeurVerificationStatus.APPROVED });
      expect(imageService.processSelfie).not.toHaveBeenCalled();
      expect(databaseService.user.update).not.toHaveBeenCalled();
      expect(databaseService.user.updateMany).not.toHaveBeenCalled();
    });

    it("requires NIN identity before driving verification", async () => {
      databaseService.chauffeurVerification.findUniqueOrThrow.mockResolvedValueOnce(
        phoneVerified(),
      );

      await expect(
        service.verifyDriving(
          VERIFICATION_ID,
          "drive-key-1",
          { driversLicenseNumber: "ABC12345" },
          selfie,
        ),
      ).rejects.toBeInstanceOf(ChauffeurStepIncompleteException);
    });

    it("rejects an identity mismatch, underage driver, and expired licence", async () => {
      databaseService.chauffeurVerification.findUniqueOrThrow.mockResolvedValue(identityVerified());
      await claimDrivingStage();
      premblyService.verifyDriversLicense.mockResolvedValueOnce({
        ...eligibleLicense,
        firstName: "OTHER",
      });
      await expect(
        service.verifyDriving(
          VERIFICATION_ID,
          "drive-key-1",
          { driversLicenseNumber: "ABC12345" },
          selfie,
        ),
      ).rejects.toBeInstanceOf(ChauffeurIdentityMismatchException);

      await claimDrivingStage();
      const today = new Date();
      premblyService.verifyDriversLicense.mockResolvedValueOnce({
        ...eligibleLicense,
        dateOfBirth: new Date(
          Date.UTC(today.getUTCFullYear() - 20, today.getUTCMonth(), today.getUTCDate()),
        ),
      });
      await expect(
        service.verifyDriving(
          VERIFICATION_ID,
          "drive-key-2",
          { driversLicenseNumber: "ABC12345" },
          selfie,
        ),
      ).rejects.toBeInstanceOf(ChauffeurMinimumAgeException);

      await claimDrivingStage();
      premblyService.verifyDriversLicense.mockResolvedValueOnce({
        ...eligibleLicense,
        expiresAt: new Date(
          Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1),
        ),
      });
      await expect(
        service.verifyDriving(
          VERIFICATION_ID,
          "drive-key-3",
          { driversLicenseNumber: "ABC12345" },
          selfie,
        ),
      ).rejects.toBeInstanceOf(ChauffeurLicenseExpiredException);
    });

    it("maps a rejected licence lookup", async () => {
      databaseService.chauffeurVerification.findUniqueOrThrow.mockResolvedValueOnce(
        identityVerified(),
      );
      await claimDrivingStage();
      premblyService.verifyDriversLicense.mockRejectedValueOnce(new PremblyError("REJECTED"));

      await expect(
        service.verifyDriving(
          VERIFICATION_ID,
          "drive-key-1",
          { driversLicenseNumber: "ABC12345" },
          selfie,
        ),
      ).rejects.toBeInstanceOf(ChauffeurLicenseNotVerifiedException);
    });

    it("creates a new approved chauffeur user when no account exists", async () => {
      const approved = identityVerified({
        chauffeurId: "new-user",
        status: ChauffeurVerificationStatus.APPROVED,
        identityProviderRef: "nin-ref",
      });
      databaseService.chauffeurVerification.findUniqueOrThrow
        .mockResolvedValueOnce(identityVerified())
        .mockResolvedValueOnce(approved);
      await claimDrivingStage();
      premblyService.verifyDriversLicense.mockResolvedValueOnce(eligibleLicense);
      premblyService.verifyFaceLiveness.mockResolvedValueOnce({
        confidence: 0.91,
        reference: "live-ref",
      });
      premblyService.compareFaces.mockResolvedValueOnce({ confidence: 88 });
      databaseService.user.findFirst.mockResolvedValueOnce(null);
      databaseService.user.create.mockResolvedValueOnce({ id: "new-user" });

      await expect(
        service.verifyDriving(
          VERIFICATION_ID,
          "drive-key-1",
          { driversLicenseNumber: "ABC12345" },
          selfie,
        ),
      ).resolves.toMatchObject({
        status: ChauffeurVerificationStatus.APPROVED,
        steps: expect.objectContaining({ driving: true }),
      });
      expect(databaseService.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          email: INVITE_INPUT.email,
          fleetOwnerId: OWNER_ID,
          chauffeurApprovalStatus: ChauffeurApprovalStatus.APPROVED,
          hasOnboarded: true,
          roles: { connect: { name: USER } },
        }),
        select: { id: true },
      });
      expect(databaseService.user.create.mock.calls[0][0].data).not.toHaveProperty("image");
      expect(storageService.uploadBuffer).toHaveBeenCalledWith(
        expect.any(Buffer),
        SELFIE_OBJECT_KEY,
        "image/jpeg",
      );
      expect(databaseService.chauffeurVerification.update).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID },
        data: expect.objectContaining({
          chauffeurId: "new-user",
          selfieObjectKey: SELFIE_OBJECT_KEY,
          status: ChauffeurVerificationStatus.APPROVED,
        }),
      });
    });

    it.each([
      ["liveness below 0.8", { liveness: 0.799, face: 90 }],
      ["face match below 80", { liveness: 0.9, face: 79.9 }],
    ] as const)("rejects %s biometric confidence", async (_label, scores) => {
      databaseService.chauffeurVerification.findUniqueOrThrow.mockResolvedValueOnce(
        identityVerified(),
      );
      await claimDrivingStage();
      premblyService.verifyDriversLicense.mockResolvedValueOnce(eligibleLicense);
      premblyService.verifyFaceLiveness.mockResolvedValueOnce({
        confidence: scores.liveness,
        reference: "live-ref",
      });
      premblyService.compareFaces.mockResolvedValueOnce({ confidence: scores.face });

      await expect(
        service.verifyDriving(
          VERIFICATION_ID,
          "drive-key-1",
          { driversLicenseNumber: "ABC12345" },
          selfie,
        ),
      ).rejects.toBeInstanceOf(ChauffeurBiometricNotVerifiedException);
      expect(storageService.uploadBuffer).not.toHaveBeenCalled();
      expect(databaseService.chauffeurVerificationStageRequest.updateMany).toHaveBeenCalledWith({
        where: { id: "stage-drive", status: ProviderVerificationStatus.PROCESSING },
        data: {
          status: ProviderVerificationStatus.FAILED,
          failureReason: ChauffeurErrorCode.BIOMETRIC_NOT_VERIFIED,
        },
      });
    });

    it("accepts boundary liveness 0.8 and face match 80", async () => {
      databaseService.chauffeurVerification.findUniqueOrThrow
        .mockResolvedValueOnce(identityVerified())
        .mockResolvedValueOnce(
          identityVerified({
            chauffeurId: "new-user",
            status: ChauffeurVerificationStatus.APPROVED,
          }),
        );
      await claimDrivingStage();
      premblyService.verifyDriversLicense.mockResolvedValueOnce(eligibleLicense);
      premblyService.verifyFaceLiveness.mockResolvedValueOnce({
        confidence: 0.8,
        reference: "live-ref",
      });
      premblyService.compareFaces.mockResolvedValueOnce({ confidence: 80 });
      databaseService.user.findFirst.mockResolvedValueOnce(null);
      databaseService.user.create.mockResolvedValueOnce({ id: "new-user" });

      await expect(
        service.verifyDriving(
          VERIFICATION_ID,
          "drive-key-1",
          { driversLicenseNumber: "ABC12345" },
          selfie,
        ),
      ).resolves.toMatchObject({ status: ChauffeurVerificationStatus.APPROVED });
    });

    it("maps a unique NIN or licence collision to ACCOUNT_CONFLICT", async () => {
      databaseService.chauffeurVerification.findUniqueOrThrow.mockResolvedValueOnce(
        identityVerified(),
      );
      await claimDrivingStage();
      premblyService.verifyDriversLicense.mockResolvedValueOnce(eligibleLicense);
      premblyService.verifyFaceLiveness.mockResolvedValueOnce({
        confidence: 0.9,
        reference: "live-ref",
      });
      premblyService.compareFaces.mockResolvedValueOnce({ confidence: 90 });
      databaseService.$transaction.mockRejectedValueOnce(uniqueConstraintError());

      await expect(
        service.verifyDriving(
          VERIFICATION_ID,
          "drive-key-1",
          { driversLicenseNumber: "ABC12345" },
          selfie,
        ),
      ).rejects.toBeInstanceOf(ChauffeurAccountConflictException);
      expect(storageService.deleteObjectByKey).toHaveBeenCalledWith(SELFIE_OBJECT_KEY);
      expect(databaseService.chauffeurVerificationStageRequest.updateMany).toHaveBeenCalledWith({
        where: { id: "stage-drive", status: ProviderVerificationStatus.PROCESSING },
        data: {
          status: ProviderVerificationStatus.FAILED,
          failureReason: ChauffeurErrorCode.ACCOUNT_CONFLICT,
        },
      });
    });

    it("stores and replays OPERATION_FAILED after an unexpected completion error", async () => {
      databaseService.chauffeurVerification.findUniqueOrThrow.mockResolvedValueOnce(
        identityVerified(),
      );
      await claimDrivingStage();
      premblyService.verifyDriversLicense.mockResolvedValueOnce(eligibleLicense);
      premblyService.verifyFaceLiveness.mockResolvedValueOnce({
        confidence: 0.9,
        reference: "live-ref",
      });
      premblyService.compareFaces.mockResolvedValueOnce({ confidence: 90 });
      databaseService.$transaction.mockRejectedValueOnce(new Error("tx exploded"));

      await expect(
        service.verifyDriving(
          VERIFICATION_ID,
          "drive-key-1",
          { driversLicenseNumber: "ABC12345" },
          selfie,
        ),
      ).rejects.toBeInstanceOf(ChauffeurOperationFailedException);
      expect(databaseService.chauffeurVerificationStageRequest.updateMany).toHaveBeenCalledWith({
        where: { id: "stage-drive", status: ProviderVerificationStatus.PROCESSING },
        data: {
          status: ProviderVerificationStatus.FAILED,
          failureReason: ChauffeurErrorCode.OPERATION_FAILED,
        },
      });

      databaseService.chauffeurVerification.findUniqueOrThrow.mockResolvedValueOnce(
        identityVerified(),
      );
      databaseService.chauffeurVerificationStageRequest.findUnique.mockResolvedValueOnce({
        id: "stage-drive",
        stage: ChauffeurVerificationStage.DRIVING,
        requestHash: hash(
          JSON.stringify({
            driversLicenseNumber: "ABC12345",
            selfie: hash(Buffer.from("processed-selfie").toString()),
          }),
        ),
        status: ProviderVerificationStatus.FAILED,
        failureReason: ChauffeurErrorCode.OPERATION_FAILED,
      });
      premblyService.verifyDriversLicense.mockClear();
      storageService.uploadBuffer.mockClear();

      await expect(
        service.verifyDriving(
          VERIFICATION_ID,
          "drive-key-1",
          { driversLicenseNumber: "ABC12345" },
          selfie,
        ),
      ).rejects.toBeInstanceOf(ChauffeurOperationFailedException);
      expect(premblyService.verifyDriversLicense).not.toHaveBeenCalled();
      expect(storageService.uploadBuffer).not.toHaveBeenCalled();
    });

    it("links an existing user account that is eligible", async () => {
      databaseService.chauffeurVerification.findUniqueOrThrow
        .mockResolvedValueOnce(identityVerified())
        .mockResolvedValueOnce(
          identityVerified({
            chauffeurId: "existing-user",
            status: ChauffeurVerificationStatus.APPROVED,
          }),
        );
      await claimDrivingStage();
      premblyService.verifyDriversLicense.mockResolvedValueOnce(eligibleLicense);
      premblyService.verifyFaceLiveness.mockResolvedValueOnce({
        confidence: 0.9,
        reference: "live-ref",
      });
      premblyService.compareFaces.mockResolvedValueOnce({ confidence: 90 });
      databaseService.user.findFirst.mockResolvedValueOnce({ id: "existing-user" });
      databaseService.user.findUnique.mockResolvedValueOnce({
        id: "existing-user",
        fleetOwnerId: null,
        isOwnerDriver: false,
        roles: [{ name: USER }],
      });
      databaseService.user.update.mockResolvedValueOnce({ id: "existing-user" });

      await expect(
        service.verifyDriving(
          VERIFICATION_ID,
          "drive-key-1",
          { driversLicenseNumber: "ABC12345" },
          selfie,
        ),
      ).resolves.toMatchObject({ status: ChauffeurVerificationStatus.APPROVED });
      expect(databaseService.user.update).toHaveBeenCalledWith({
        where: { id: "existing-user" },
        data: expect.objectContaining({
          fleetOwnerId: OWNER_ID,
          chauffeurApprovalStatus: ChauffeurApprovalStatus.APPROVED,
          chauffeurDisabledAt: null,
        }),
        select: { id: true },
      });
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
        "a user already linked to another fleet",
        { id: "other", fleetOwnerId: "other-owner", isOwnerDriver: false, roles: [{ name: USER }] },
      ],
      [
        "a non-user role",
        { id: "other", fleetOwnerId: null, isOwnerDriver: false, roles: [{ name: "fleetOwner" }] },
      ],
    ] as const)("rejects linking %s", async (_label, existing) => {
      databaseService.chauffeurVerification.findUniqueOrThrow.mockResolvedValueOnce(
        identityVerified(),
      );
      await claimDrivingStage();
      premblyService.verifyDriversLicense.mockResolvedValueOnce(eligibleLicense);
      premblyService.verifyFaceLiveness.mockResolvedValueOnce({
        confidence: 0.9,
        reference: "live-ref",
      });
      premblyService.compareFaces.mockResolvedValueOnce({ confidence: 90 });
      databaseService.user.findFirst.mockResolvedValueOnce({ id: existing.id });
      databaseService.user.findUnique.mockResolvedValueOnce(existing);

      await expect(
        service.verifyDriving(
          VERIFICATION_ID,
          "drive-key-1",
          { driversLicenseNumber: "ABC12345" },
          selfie,
        ),
      ).rejects.toBeInstanceOf(ChauffeurAccountConflictException);
      expect(storageService.deleteObjectByKey).toHaveBeenCalled();
    });

    it("maps a rejected biometric check", async () => {
      databaseService.chauffeurVerification.findUniqueOrThrow.mockResolvedValueOnce(
        identityVerified(),
      );
      await claimDrivingStage();
      premblyService.verifyDriversLicense.mockResolvedValueOnce(eligibleLicense);
      premblyService.verifyFaceLiveness.mockRejectedValueOnce(new PremblyError("REJECTED"));

      await expect(
        service.verifyDriving(
          VERIFICATION_ID,
          "drive-key-1",
          { driversLicenseNumber: "ABC12345" },
          selfie,
        ),
      ).rejects.toBeInstanceOf(ChauffeurBiometricNotVerifiedException);
    });

    it("maps an unexpected Prembly outage", async () => {
      databaseService.chauffeurVerification.findUniqueOrThrow.mockResolvedValueOnce(
        identityVerified(),
      );
      await claimDrivingStage();
      premblyService.verifyDriversLicense.mockRejectedValueOnce(new PremblyError("UNAVAILABLE"));

      await expect(
        service.verifyDriving(
          VERIFICATION_ID,
          "drive-key-1",
          { driversLicenseNumber: "ABC12345" },
          selfie,
        ),
      ).rejects.toBeInstanceOf(ChauffeurProviderUnavailableException);
    });
  });
});
