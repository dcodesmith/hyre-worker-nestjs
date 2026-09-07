import { createHash, createHmac } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import {
  AccountVerificationStatus,
  DocumentStatus,
  DocumentType,
  FleetOwnerAccountType,
  FleetOwnerStatus,
  NameMatchStatus,
  Prisma,
} from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { DatabaseService } from "../database/database.service";
import { FlutterwaveError } from "../flutterwave/flutterwave.interface";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";
import { PremblyError, PremblyService } from "../prembly/prembly.service";
import { StorageService } from "../storage/storage.service";
import type {
  CreateAccountVerificationDto,
  UploadedAccountDocument,
} from "./account-verification.dto";
import {
  AccountAlreadyVerifiedException,
  AccountDocumentInvalidException,
  AccountEmailNotVerifiedException,
  AccountManualReviewRejectedException,
  AccountPhoneNotVerifiedException,
  AccountVerificationErrorCode,
  AccountVerificationOperationFailedException,
  AccountVerificationReviewNotFoundException,
  AccountVerificationReviewNotPendingException,
  AccountVerificationReviewPendingException,
  BankAccountNameMismatchException,
  BankAccountProviderUnavailableException,
  BankAccountUnresolvedException,
  BusinessInactiveException,
  BusinessNameMismatchException,
  OwnerDriverLicenseNotApprovedException,
  OwnerDriverLicenseRequiredException,
} from "./account-verification.error";
import { AccountVerificationService } from "./account-verification.service";
import {
  ProviderVerificationException,
  VerificationErrorCode,
  VerificationIdempotencyKeyReusedException,
  VerificationRequestInProgressException,
} from "./verification.error";

const HMAC_KEY = "test-hmac-key";
const USER_ID = "user-1";
const REVIEWER_ID = "admin-1";
const IDEMPOTENCY_KEY = "account-key-1";
const VERIFICATION_ID = "ver-1";
const PHONE_NUMBER = "+2348012345678";

const uniqueConstraintError = () =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
  });

const licenseFile = (name = "license.pdf"): UploadedAccountDocument => ({
  originalname: name,
  mimetype: "application/pdf",
  size: 1024,
  buffer: Buffer.from(`license-${name}`),
});

const individualInput = (
  overrides: Partial<Extract<CreateAccountVerificationDto, { accountType: "INDIVIDUAL" }>> = {},
): Extract<CreateAccountVerificationDto, { accountType: "INDIVIDUAL" }> => ({
  accountType: "INDIVIDUAL",
  nin: "12345678901",
  isOwnerDriver: false,
  bankName: "GTBank",
  bankCode: "058",
  accountNumber: "0123456789",
  ...overrides,
});

const businessInput = (
  overrides: Partial<Extract<CreateAccountVerificationDto, { accountType: "BUSINESS" }>> = {},
): Extract<CreateAccountVerificationDto, { accountType: "BUSINESS" }> => ({
  accountType: "BUSINESS",
  nin: "12345678901",
  isOwnerDriver: false,
  bankName: "GTBank",
  bankCode: "058",
  accountNumber: "0123456789",
  businessName: "Hyre Mobility Limited",
  registrationNumber: "RC123456",
  registrationType: "RC",
  ...overrides,
});

const requestHash = (
  input: CreateAccountVerificationDto,
  documents: { driversLicense?: UploadedAccountDocument; lasdri?: UploadedAccountDocument } = {},
) => {
  const fileHash = (file?: UploadedAccountDocument) =>
    file ? createHash("sha256").update(file.buffer).digest("hex") : null;
  return createHmac("sha256", HMAC_KEY)
    .update(
      JSON.stringify({
        ...input,
        driversLicense: fileHash(documents.driversLicense),
        lasdri: fileHash(documents.lasdri),
      }),
    )
    .digest("hex");
};

const identity = {
  firstName: "JOHN",
  middleName: "MIDDLE",
  lastName: "DOE",
  reference: "nin-ref",
};

const cac = {
  businessName: "HYRE MOBILITY LTD",
  registrationNumber: "RC123456",
  registrationType: "RC",
  status: "ACTIVE",
  directors: [{ firstName: "JOHN", middleName: null, lastName: "DOE" }],
  reference: "cac-ref",
};

const resolvedAccount = {
  accountNumber: "0123456789",
  accountName: "JOHN DOE",
  bankCode: "058",
};

const processingRecord = (overrides: Record<string, unknown> = {}) => ({
  id: VERIFICATION_ID,
  userId: USER_ID,
  idempotencyKey: IDEMPOTENCY_KEY,
  requestHash: requestHash(individualInput()),
  accountType: FleetOwnerAccountType.INDIVIDUAL,
  isOwnerDriver: false,
  status: AccountVerificationStatus.PROCESSING,
  legalName: null,
  businessName: null,
  registrationNumber: null,
  registrationType: null,
  identityProviderRef: null,
  businessProviderRef: null,
  bankName: null,
  bankCode: null,
  accountNumberLast4: null,
  accountName: null,
  bankNameMatch: null,
  representativeNameMatch: null,
  businessNameMatch: null,
  processingExpiresAt: new Date("2026-01-01T00:15:00Z"),
  reviewedById: null,
  reviewedAt: null,
  reviewNotes: null,
  failureReason: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  ...overrides,
});

const succeededRecord = (overrides: Record<string, unknown> = {}) =>
  processingRecord({
    status: AccountVerificationStatus.SUCCEEDED,
    legalName: "JOHN MIDDLE DOE",
    bankName: "GTBank",
    bankCode: "058",
    accountNumberLast4: "6789",
    accountName: "JOHN DOE",
    bankNameMatch: NameMatchStatus.MATCHED,
    ...overrides,
  });

describe("AccountVerificationService", () => {
  let service: AccountVerificationService;
  let databaseService: {
    user: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    fleetOwnerAccountVerification: {
      create: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    documentApproval: {
      findUnique: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
    };
    bankDetails: { upsert: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let logger: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  let premblyService: { verifyNin: ReturnType<typeof vi.fn>; verifyCac: ReturnType<typeof vi.fn> };
  let flutterwaveService: { resolveBankAccount: ReturnType<typeof vi.fn> };
  let storageService: {
    uploadBuffer: ReturnType<typeof vi.fn>;
    deleteObjectByKey: ReturnType<typeof vi.fn>;
  };

  const readyUser = {
    emailVerified: true,
    phoneVerifiedAt: new Date(),
    fleetOwnerStatus: FleetOwnerStatus.PROCESSING,
    isOwnerDriver: false,
  };

  beforeEach(async () => {
    databaseService = {
      user: { findUnique: vi.fn().mockResolvedValue(readyUser), update: vi.fn() },
      fleetOwnerAccountVerification: {
        create: vi.fn().mockResolvedValue(processingRecord()),
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      documentApproval: {
        findUnique: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
        upsert: vi.fn(),
      },
      bankDetails: { upsert: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      $transaction: vi.fn(),
    };
    premblyService = {
      verifyNin: vi.fn().mockResolvedValue(identity),
      verifyCac: vi.fn().mockResolvedValue(cac),
    };
    flutterwaveService = {
      resolveBankAccount: vi.fn().mockResolvedValue(resolvedAccount),
    };
    storageService = {
      uploadBuffer: vi
        .fn()
        .mockImplementation(async (_buffer: Buffer, key: string) => `https://cdn.test/${key}`),
      deleteObjectByKey: vi.fn().mockResolvedValue(undefined),
    };

    databaseService.$transaction.mockImplementation(async (callback) =>
      callback({
        bankDetails: databaseService.bankDetails,
        documentApproval: databaseService.documentApproval,
        user: databaseService.user,
        fleetOwnerAccountVerification: {
          update: vi.fn().mockResolvedValue(succeededRecord()),
        },
      }),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountVerificationService,
        { provide: DatabaseService, useValue: databaseService },
        { provide: PremblyService, useValue: premblyService },
        { provide: FlutterwaveService, useValue: flutterwaveService },
        { provide: StorageService, useValue: storageService },
        {
          provide: ConfigService,
          useValue: { get: vi.fn((key: string) => (key === "HMAC_KEY" ? HMAC_KEY : undefined)) },
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get(AccountVerificationService);
    logger = module.get(PinoLogger);
  });

  const mockReviewTransaction = (record: ReturnType<typeof succeededRecord>) => {
    databaseService.$transaction.mockImplementationOnce(async (callback) =>
      callback({
        bankDetails: databaseService.bankDetails,
        documentApproval: databaseService.documentApproval,
        user: databaseService.user,
        fleetOwnerAccountVerification: {
          update: vi.fn().mockResolvedValue(record),
        },
      }),
    );
  };

  describe("create", () => {
    it("rejects an unverified email before calling providers", async () => {
      databaseService.user.findUnique.mockResolvedValueOnce({
        ...readyUser,
        emailVerified: false,
      });

      await expect(
        service.create(USER_ID, IDEMPOTENCY_KEY, individualInput(), {}),
      ).rejects.toBeInstanceOf(AccountEmailNotVerifiedException);
      expect(premblyService.verifyNin).not.toHaveBeenCalled();
    });

    it("rejects an unverified phone before calling providers", async () => {
      databaseService.user.findUnique.mockResolvedValueOnce({
        ...readyUser,
        phoneVerifiedAt: null,
      });

      await expect(
        service.create(USER_ID, IDEMPOTENCY_KEY, individualInput(), {}),
      ).rejects.toBeInstanceOf(AccountPhoneNotVerifiedException);
    });

    it("verifies an individual account and returns a masked bank number", async () => {
      const result = await service.create(USER_ID, IDEMPOTENCY_KEY, individualInput(), {});

      expect(premblyService.verifyNin).toHaveBeenCalledWith("12345678901");
      expect(premblyService.verifyCac).not.toHaveBeenCalled();
      expect(flutterwaveService.resolveBankAccount).toHaveBeenCalledWith("058", "0123456789");
      expect(result).toMatchObject({
        id: VERIFICATION_ID,
        status: AccountVerificationStatus.SUCCEEDED,
        accountType: FleetOwnerAccountType.INDIVIDUAL,
        legalName: "JOHN MIDDLE DOE",
        bank: {
          bankName: "GTBank",
          accountName: "JOHN DOE",
          accountNumber: "******6789",
          nameMatch: NameMatchStatus.MATCHED,
        },
      });
    });

    it("verifies a business account against CAC and the company bank name", async () => {
      flutterwaveService.resolveBankAccount.mockResolvedValueOnce({
        ...resolvedAccount,
        accountName: "HYRE MOBILITY LIMITED",
      });
      databaseService.$transaction.mockImplementationOnce(async (callback) =>
        callback({
          bankDetails: databaseService.bankDetails,
          documentApproval: databaseService.documentApproval,
          user: databaseService.user,
          fleetOwnerAccountVerification: {
            update: vi.fn().mockResolvedValue(
              succeededRecord({
                accountType: FleetOwnerAccountType.BUSINESS,
                businessName: "HYRE MOBILITY LTD",
                accountName: "HYRE MOBILITY LIMITED",
              }),
            ),
          },
        }),
      );

      const result = await service.create(USER_ID, IDEMPOTENCY_KEY, businessInput(), {});

      expect(premblyService.verifyCac).toHaveBeenCalledWith(
        "RC123456",
        "RC",
        "Hyre Mobility Limited",
      );
      expect(result).toMatchObject({
        status: AccountVerificationStatus.SUCCEEDED,
        businessName: "HYRE MOBILITY LTD",
      });
    });

    it("rejects an owner-driver who has never uploaded a licence", async () => {
      databaseService.documentApproval.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.create(USER_ID, IDEMPOTENCY_KEY, individualInput({ isOwnerDriver: true }), {}),
      ).rejects.toBeInstanceOf(OwnerDriverLicenseRequiredException);
      expect(premblyService.verifyNin).not.toHaveBeenCalled();
    });

    it("rejects an owner-driver whose existing licence was rejected", async () => {
      databaseService.documentApproval.findUnique.mockResolvedValueOnce({
        status: DocumentStatus.REJECTED,
      });

      await expect(
        service.create(USER_ID, IDEMPOTENCY_KEY, individualInput({ isOwnerDriver: true }), {}),
      ).rejects.toBeInstanceOf(OwnerDriverLicenseRequiredException);
    });

    it("automatically succeeds when an owner-driver already has an APPROVED licence", async () => {
      databaseService.documentApproval.findUnique.mockResolvedValueOnce({
        status: DocumentStatus.APPROVED,
      });

      await expect(
        service.create(USER_ID, IDEMPOTENCY_KEY, individualInput({ isOwnerDriver: true }), {}),
      ).resolves.toMatchObject({ status: AccountVerificationStatus.SUCCEEDED });
      expect(storageService.uploadBuffer).not.toHaveBeenCalled();
      expect(databaseService.bankDetails.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ isVerified: true }),
          update: expect.objectContaining({ isVerified: true }),
        }),
      );
      expect(databaseService.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: expect.objectContaining({ fleetOwnerStatus: FleetOwnerStatus.APPROVED }),
      });
    });

    it("sends an owner-driver with an existing PENDING licence to review", async () => {
      databaseService.documentApproval.findUnique.mockResolvedValueOnce({
        status: DocumentStatus.PENDING,
      });
      mockReviewTransaction(
        succeededRecord({
          status: AccountVerificationStatus.REVIEW_REQUIRED,
          isOwnerDriver: true,
        }),
      );

      await expect(
        service.create(USER_ID, IDEMPOTENCY_KEY, individualInput({ isOwnerDriver: true }), {}),
      ).resolves.toMatchObject({ status: AccountVerificationStatus.REVIEW_REQUIRED });
      expect(databaseService.bankDetails.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ isVerified: false }),
          update: expect.objectContaining({ isVerified: false }),
        }),
      );
      expect(databaseService.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: expect.objectContaining({ fleetOwnerStatus: FleetOwnerStatus.PROCESSING }),
      });
    });

    it("rejects driver documents uploaded for a non-owner-driver", async () => {
      await expect(
        service.create(USER_ID, IDEMPOTENCY_KEY, individualInput(), {
          driversLicense: licenseFile(),
        }),
      ).rejects.toBeInstanceOf(AccountDocumentInvalidException);
    });

    it("sends a new owner-driver licence to review and leaves the bank unverified", async () => {
      const licence = licenseFile();
      mockReviewTransaction(
        succeededRecord({
          status: AccountVerificationStatus.REVIEW_REQUIRED,
          isOwnerDriver: true,
        }),
      );

      const result = await service.create(
        USER_ID,
        IDEMPOTENCY_KEY,
        individualInput({ isOwnerDriver: true }),
        { driversLicense: licence },
      );

      expect(result.status).toBe(AccountVerificationStatus.REVIEW_REQUIRED);
      expect(storageService.uploadBuffer).toHaveBeenCalledTimes(1);
      expect(storageService.uploadBuffer).toHaveBeenCalledWith(
        licence.buffer,
        expect.stringContaining("drivers_license"),
        "application/pdf",
      );
      expect(databaseService.bankDetails.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ isVerified: false }),
          update: expect.objectContaining({ isVerified: false }),
        }),
      );
      expect(databaseService.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: expect.objectContaining({
          isOwnerDriver: true,
          hasOnboarded: true,
          fleetOwnerStatus: FleetOwnerStatus.PROCESSING,
        }),
      });
    });

    it("uploads optional LASDRI without changing a review-required outcome", async () => {
      const licence = licenseFile();
      const lasdri = licenseFile("lasdri.pdf");
      mockReviewTransaction(
        succeededRecord({
          status: AccountVerificationStatus.REVIEW_REQUIRED,
          isOwnerDriver: true,
        }),
      );

      await expect(
        service.create(USER_ID, IDEMPOTENCY_KEY, individualInput({ isOwnerDriver: true }), {
          driversLicense: licence,
          lasdri,
        }),
      ).resolves.toMatchObject({ status: AccountVerificationStatus.REVIEW_REQUIRED });
      expect(storageService.uploadBuffer).toHaveBeenCalledTimes(2);
    });

    it("treats accent-normalized person names as an exact match", async () => {
      premblyService.verifyNin.mockResolvedValueOnce({
        firstName: "José",
        middleName: null,
        lastName: "Doe",
        reference: "nin-ref",
      });
      flutterwaveService.resolveBankAccount.mockResolvedValueOnce({
        ...resolvedAccount,
        accountName: "JOSE DOE",
      });

      await expect(
        service.create(USER_ID, IDEMPOTENCY_KEY, individualInput(), {}),
      ).resolves.toMatchObject({ status: AccountVerificationStatus.SUCCEEDED });
    });

    it("treats titled person names as an exact match", async () => {
      flutterwaveService.resolveBankAccount.mockResolvedValueOnce({
        ...resolvedAccount,
        accountName: "Mr. John Doe",
      });

      await expect(
        service.create(USER_ID, IDEMPOTENCY_KEY, individualInput(), {}),
      ).resolves.toMatchObject({ status: AccountVerificationStatus.SUCCEEDED });
    });

    it("sends a partial person-name match to review instead of failing", async () => {
      flutterwaveService.resolveBankAccount.mockResolvedValueOnce({
        ...resolvedAccount,
        accountName: "JOHN SMITH",
      });
      databaseService.$transaction.mockImplementationOnce(async (callback) =>
        callback({
          bankDetails: databaseService.bankDetails,
          documentApproval: databaseService.documentApproval,
          user: databaseService.user,
          fleetOwnerAccountVerification: {
            update: vi.fn().mockResolvedValue(
              succeededRecord({
                status: AccountVerificationStatus.REVIEW_REQUIRED,
                accountName: "JOHN SMITH",
                bankNameMatch: NameMatchStatus.REVIEW_REQUIRED,
              }),
            ),
          },
        }),
      );

      const result = await service.create(USER_ID, IDEMPOTENCY_KEY, individualInput(), {});

      expect(result.status).toBe(AccountVerificationStatus.REVIEW_REQUIRED);
      expect(databaseService.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: expect.objectContaining({ fleetOwnerStatus: FleetOwnerStatus.PROCESSING }),
      });
    });

    it("rejects a fully mismatched person bank name", async () => {
      flutterwaveService.resolveBankAccount.mockResolvedValueOnce({
        ...resolvedAccount,
        accountName: "JANE SMITH",
      });

      await expect(
        service.create(USER_ID, IDEMPOTENCY_KEY, individualInput(), {}),
      ).rejects.toBeInstanceOf(BankAccountNameMismatchException);
      expect(databaseService.fleetOwnerAccountVerification.updateMany).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID, status: AccountVerificationStatus.PROCESSING },
        data: {
          status: AccountVerificationStatus.FAILED,
          failureReason: AccountVerificationErrorCode.BANK_ACCOUNT_NAME_MISMATCH,
        },
      });
    });

    it("matches business names after dropping corporate suffixes", async () => {
      flutterwaveService.resolveBankAccount.mockResolvedValueOnce({
        ...resolvedAccount,
        accountName: "HYRE MOBILITY LIMITED",
      });

      await expect(
        service.create(USER_ID, IDEMPOTENCY_KEY, businessInput(), {}),
      ).resolves.toMatchObject({ status: AccountVerificationStatus.SUCCEEDED });
    });

    it("sends a partial business-name overlap to review", async () => {
      premblyService.verifyCac.mockResolvedValueOnce({
        ...cac,
        businessName: "HYRE MOBILITY SERVICES LTD",
      });
      flutterwaveService.resolveBankAccount.mockResolvedValueOnce({
        ...resolvedAccount,
        accountName: "HYRE MOBILITY SERVICES LIMITED",
      });
      databaseService.$transaction.mockImplementationOnce(async (callback) =>
        callback({
          bankDetails: databaseService.bankDetails,
          documentApproval: databaseService.documentApproval,
          user: databaseService.user,
          fleetOwnerAccountVerification: {
            update: vi.fn().mockResolvedValue(
              succeededRecord({
                status: AccountVerificationStatus.REVIEW_REQUIRED,
                businessName: "HYRE MOBILITY SERVICES LTD",
              }),
            ),
          },
        }),
      );

      await expect(
        service.create(
          USER_ID,
          IDEMPOTENCY_KEY,
          businessInput({ businessName: "Hyre Mobility Limited" }),
          {},
        ),
      ).resolves.toMatchObject({ status: AccountVerificationStatus.REVIEW_REQUIRED });
    });

    it("rejects a mismatched supplied business name", async () => {
      premblyService.verifyCac.mockResolvedValueOnce({
        ...cac,
        businessName: "ACME LOGISTICS PLC",
      });

      await expect(
        service.create(USER_ID, IDEMPOTENCY_KEY, businessInput(), {}),
      ).rejects.toBeInstanceOf(BusinessNameMismatchException);
    });

    it("rejects an inactive CAC record", async () => {
      premblyService.verifyCac.mockResolvedValueOnce({ ...cac, status: "INACTIVE" });

      await expect(
        service.create(USER_ID, IDEMPOTENCY_KEY, businessInput(), {}),
      ).rejects.toBeInstanceOf(BusinessInactiveException);
    });

    it("sends a missing CAC status to review", async () => {
      premblyService.verifyCac.mockResolvedValueOnce({ ...cac, status: null });
      flutterwaveService.resolveBankAccount.mockResolvedValueOnce({
        ...resolvedAccount,
        accountName: "HYRE MOBILITY LIMITED",
      });
      databaseService.$transaction.mockImplementationOnce(async (callback) =>
        callback({
          bankDetails: databaseService.bankDetails,
          documentApproval: databaseService.documentApproval,
          user: databaseService.user,
          fleetOwnerAccountVerification: {
            update: vi
              .fn()
              .mockResolvedValue(
                succeededRecord({ status: AccountVerificationStatus.REVIEW_REQUIRED }),
              ),
          },
        }),
      );

      await expect(
        service.create(USER_ID, IDEMPOTENCY_KEY, businessInput(), {}),
      ).resolves.toMatchObject({ status: AccountVerificationStatus.REVIEW_REQUIRED });
    });

    it("sends a representative who is not an exact director match to review", async () => {
      premblyService.verifyCac.mockResolvedValueOnce({
        ...cac,
        directors: [{ firstName: "JANE", middleName: null, lastName: "SMITH" }],
      });
      flutterwaveService.resolveBankAccount.mockResolvedValueOnce({
        ...resolvedAccount,
        accountName: "HYRE MOBILITY LIMITED",
      });
      databaseService.$transaction.mockImplementationOnce(async (callback) =>
        callback({
          bankDetails: databaseService.bankDetails,
          documentApproval: databaseService.documentApproval,
          user: databaseService.user,
          fleetOwnerAccountVerification: {
            update: vi.fn().mockResolvedValue(
              succeededRecord({
                status: AccountVerificationStatus.REVIEW_REQUIRED,
                representativeNameMatch: NameMatchStatus.REVIEW_REQUIRED,
              }),
            ),
          },
        }),
      );

      await expect(
        service.create(USER_ID, IDEMPOTENCY_KEY, businessInput(), {}),
      ).resolves.toMatchObject({ status: AccountVerificationStatus.REVIEW_REQUIRED });
    });

    it("replays a review-required request with the same idempotency key", async () => {
      const replay = succeededRecord({ status: AccountVerificationStatus.REVIEW_REQUIRED });
      databaseService.fleetOwnerAccountVerification.create.mockRejectedValueOnce(
        uniqueConstraintError(),
      );
      databaseService.fleetOwnerAccountVerification.findUnique.mockResolvedValueOnce(replay);

      await expect(
        service.create(USER_ID, IDEMPOTENCY_KEY, individualInput(), {}),
      ).resolves.toMatchObject({
        id: VERIFICATION_ID,
        status: AccountVerificationStatus.REVIEW_REQUIRED,
      });
      expect(premblyService.verifyNin).not.toHaveBeenCalled();
    });

    it("replays a succeeded request with the same idempotency key", async () => {
      const replay = succeededRecord();
      databaseService.fleetOwnerAccountVerification.create.mockRejectedValueOnce(
        uniqueConstraintError(),
      );
      databaseService.fleetOwnerAccountVerification.findUnique.mockResolvedValueOnce(replay);

      await expect(
        service.create(USER_ID, IDEMPOTENCY_KEY, individualInput(), {}),
      ).resolves.toMatchObject({
        id: VERIFICATION_ID,
        status: AccountVerificationStatus.SUCCEEDED,
        bank: { accountNumber: "******6789" },
      });
      expect(premblyService.verifyNin).not.toHaveBeenCalled();
    });

    it("rejects the same idempotency key used with a different payload", async () => {
      databaseService.fleetOwnerAccountVerification.create.mockRejectedValueOnce(
        uniqueConstraintError(),
      );
      databaseService.fleetOwnerAccountVerification.findUnique.mockResolvedValueOnce(
        succeededRecord({ requestHash: "other-hash" }),
      );

      await expect(
        service.create(USER_ID, IDEMPOTENCY_KEY, individualInput(), {}),
      ).rejects.toBeInstanceOf(VerificationIdempotencyKeyReusedException);
    });

    it("rejects an in-progress replay", async () => {
      databaseService.fleetOwnerAccountVerification.create.mockRejectedValueOnce(
        uniqueConstraintError(),
      );
      databaseService.fleetOwnerAccountVerification.findUnique.mockResolvedValueOnce(
        processingRecord(),
      );

      await expect(
        service.create(USER_ID, IDEMPOTENCY_KEY, individualInput(), {}),
      ).rejects.toBeInstanceOf(VerificationRequestInProgressException);
    });

    it("replays a failed request as the original domain error", async () => {
      databaseService.fleetOwnerAccountVerification.create.mockRejectedValueOnce(
        uniqueConstraintError(),
      );
      databaseService.fleetOwnerAccountVerification.findUnique.mockResolvedValueOnce(
        processingRecord({
          status: AccountVerificationStatus.FAILED,
          failureReason: AccountVerificationErrorCode.BANK_ACCOUNT_NAME_MISMATCH,
        }),
      );

      await expect(
        service.create(USER_ID, IDEMPOTENCY_KEY, individualInput(), {}),
      ).rejects.toBeInstanceOf(BankAccountNameMismatchException);
    });

    it("rejects a new key once the account is already verified", async () => {
      databaseService.user.findUnique.mockResolvedValueOnce({
        ...readyUser,
        fleetOwnerStatus: FleetOwnerStatus.APPROVED,
      });
      databaseService.fleetOwnerAccountVerification.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.create(USER_ID, "another-key-1", individualInput(), {}),
      ).rejects.toBeInstanceOf(AccountAlreadyVerifiedException);
    });

    it("replays the original success for an already-verified account with the same key", async () => {
      databaseService.user.findUnique.mockResolvedValueOnce({
        ...readyUser,
        fleetOwnerStatus: FleetOwnerStatus.APPROVED,
      });
      databaseService.fleetOwnerAccountVerification.findUnique.mockResolvedValueOnce(
        succeededRecord(),
      );

      await expect(
        service.create(USER_ID, IDEMPOTENCY_KEY, individualInput(), {}),
      ).resolves.toMatchObject({
        id: VERIFICATION_ID,
        status: AccountVerificationStatus.SUCCEEDED,
      });
    });

    it("maps a Prembly rejection to PROVIDER_REJECTED and marks the request failed", async () => {
      premblyService.verifyNin.mockRejectedValueOnce(new PremblyError("REJECTED"));

      await expect(
        service.create(USER_ID, IDEMPOTENCY_KEY, individualInput(), {}),
      ).rejects.toBeInstanceOf(ProviderVerificationException);
      expect(databaseService.fleetOwnerAccountVerification.updateMany).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID, status: AccountVerificationStatus.PROCESSING },
        data: {
          status: AccountVerificationStatus.FAILED,
          failureReason: VerificationErrorCode.PROVIDER_REJECTED,
        },
      });
    });

    it.each([400, 404, 422])(
      "maps a Flutterwave %s response to an unresolved bank account",
      async (statusCode) => {
        flutterwaveService.resolveBankAccount.mockRejectedValueOnce(
          new FlutterwaveError("Account not found", "ACCOUNT_NOT_FOUND", statusCode),
        );

        await expect(
          service.create(USER_ID, IDEMPOTENCY_KEY, individualInput(), {}),
        ).rejects.toBeInstanceOf(BankAccountUnresolvedException);
      },
    );

    it.each([401, 408, 429, 502])(
      "maps a Flutterwave %s response to bank provider unavailable",
      async (statusCode) => {
        flutterwaveService.resolveBankAccount.mockRejectedValueOnce(
          new FlutterwaveError("Provider error", "PROVIDER_ERROR", statusCode),
        );

        await expect(
          service.create(USER_ID, IDEMPOTENCY_KEY, individualInput(), {}),
        ).rejects.toBeInstanceOf(BankAccountProviderUnavailableException);
      },
    );

    it("deletes uploaded documents when verification fails after storage", async () => {
      const licence = licenseFile();
      databaseService.$transaction.mockRejectedValueOnce(new Error("db write failed"));

      await expect(
        service.create(USER_ID, IDEMPOTENCY_KEY, individualInput({ isOwnerDriver: true }), {
          driversLicense: licence,
        }),
      ).rejects.toBeInstanceOf(AccountVerificationOperationFailedException);
      expect(storageService.deleteObjectByKey).toHaveBeenCalledWith(
        expect.stringContaining("drivers_license"),
      );
    });

    it("retries document cleanup three times and logs after repeated failure", async () => {
      const licence = licenseFile();
      databaseService.$transaction.mockRejectedValueOnce(new Error("db write failed"));
      storageService.deleteObjectByKey.mockRejectedValue(new Error("s3 down"));

      await expect(
        service.create(USER_ID, IDEMPOTENCY_KEY, individualInput({ isOwnerDriver: true }), {
          driversLicense: licence,
        }),
      ).rejects.toBeInstanceOf(AccountVerificationOperationFailedException);
      expect(storageService.deleteObjectByKey).toHaveBeenCalledTimes(3);
      expect(logger.warn).toHaveBeenCalledWith(
        { error: "s3 down" },
        "Failed to delete an unreferenced account document after retries",
      );
    });

    it("fails stale PROCESSING attempts before claiming a new request", async () => {
      await service.create(USER_ID, IDEMPOTENCY_KEY, individualInput(), {});

      expect(databaseService.fleetOwnerAccountVerification.updateMany).toHaveBeenCalledWith({
        where: {
          userId: USER_ID,
          status: AccountVerificationStatus.PROCESSING,
          processingExpiresAt: { lte: expect.any(Date) },
        },
        data: {
          status: AccountVerificationStatus.FAILED,
          failureReason: AccountVerificationErrorCode.OPERATION_FAILED,
        },
      });
      expect(databaseService.fleetOwnerAccountVerification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          processingExpiresAt: expect.any(Date),
        }),
      });
    });

    it("rejects a different idempotency key while another request is processing", async () => {
      databaseService.fleetOwnerAccountVerification.create.mockRejectedValueOnce(
        uniqueConstraintError(),
      );
      databaseService.fleetOwnerAccountVerification.findUnique.mockResolvedValueOnce(null);
      databaseService.fleetOwnerAccountVerification.findFirst.mockResolvedValueOnce({
        status: AccountVerificationStatus.PROCESSING,
      });

      await expect(
        service.create(USER_ID, "other-key-1", individualInput(), {}),
      ).rejects.toBeInstanceOf(VerificationRequestInProgressException);
      expect(premblyService.verifyNin).not.toHaveBeenCalled();
    });

    it("rejects a different idempotency key while a review is pending", async () => {
      databaseService.fleetOwnerAccountVerification.create.mockRejectedValueOnce(
        uniqueConstraintError(),
      );
      databaseService.fleetOwnerAccountVerification.findUnique.mockResolvedValueOnce(null);
      databaseService.fleetOwnerAccountVerification.findFirst.mockResolvedValueOnce({
        status: AccountVerificationStatus.REVIEW_REQUIRED,
      });

      await expect(
        service.create(USER_ID, "other-key-1", individualInput(), {}),
      ).rejects.toBeInstanceOf(AccountVerificationReviewPendingException);
    });

    it("deletes replaced previous documents after a successful re-upload", async () => {
      const licence = licenseFile();
      databaseService.documentApproval.findMany.mockResolvedValueOnce([
        { documentType: DocumentType.DRIVERS_LICENSE, documentUrl: "old-license-key" },
      ]);

      await service.create(USER_ID, IDEMPOTENCY_KEY, individualInput({ isOwnerDriver: true }), {
        driversLicense: licence,
      });

      expect(storageService.deleteObjectByKey).toHaveBeenCalledWith("old-license-key");
    });
  });

  describe("getStatus", () => {
    it("returns ACTION_REQUIRED with verify steps when onboarding has not started", async () => {
      databaseService.user.findUnique.mockResolvedValueOnce({
        emailVerified: false,
        phoneNumber: PHONE_NUMBER,
        phoneVerifiedAt: null,
        hasOnboarded: false,
        isOwnerDriver: false,
        fleetOwnerStatus: FleetOwnerStatus.PROCESSING,
        bankDetails: null,
        documents: [],
        accountVerifications: [],
      });

      await expect(service.getStatus(USER_ID)).resolves.toMatchObject({
        status: "ACTION_REQUIRED",
        phone: { number: "**********5678", verified: false },
        requiredActions: ["VERIFY_EMAIL", "VERIFY_PHONE", "VERIFY_ACCOUNT"],
        bank: null,
        identity: null,
      });
    });

    it("returns UNDER_REVIEW and masks persisted bank details", async () => {
      databaseService.user.findUnique.mockResolvedValueOnce({
        emailVerified: true,
        phoneNumber: PHONE_NUMBER,
        phoneVerifiedAt: new Date(),
        hasOnboarded: true,
        isOwnerDriver: false,
        fleetOwnerStatus: FleetOwnerStatus.PROCESSING,
        bankDetails: {
          bankName: "GTBank",
          accountName: "JOHN DOE",
          accountNumber: "0123456789",
          isVerified: false,
        },
        documents: [],
        accountVerifications: [
          succeededRecord({ status: AccountVerificationStatus.REVIEW_REQUIRED }),
        ],
      });

      await expect(service.getStatus(USER_ID)).resolves.toMatchObject({
        status: "UNDER_REVIEW",
        bank: {
          bankName: "GTBank",
          accountName: "JOHN DOE",
          accountNumber: "******6789",
          verified: false,
        },
        requiredActions: [],
      });
    });

    it("returns ACTION_REQUIRED when an approved owner is missing an owner-driver licence", async () => {
      databaseService.user.findUnique.mockResolvedValueOnce({
        emailVerified: true,
        phoneNumber: PHONE_NUMBER,
        phoneVerifiedAt: new Date(),
        hasOnboarded: true,
        isOwnerDriver: true,
        fleetOwnerStatus: FleetOwnerStatus.APPROVED,
        bankDetails: {
          bankName: "GTBank",
          accountName: "JOHN DOE",
          accountNumber: "0123456789",
          isVerified: true,
        },
        documents: [{ documentType: DocumentType.LASDRI, status: DocumentStatus.PENDING }],
        accountVerifications: [succeededRecord()],
      });

      await expect(service.getStatus(USER_ID)).resolves.toMatchObject({
        status: "ACTION_REQUIRED",
        isOwnerDriver: true,
        documents: { driversLicense: null, lasdri: DocumentStatus.PENDING },
        requiredActions: ["UPLOAD_DRIVERS_LICENSE"],
      });
    });

    it("does not return VERIFIED when a previously approved owner no longer has a verified phone", async () => {
      databaseService.user.findUnique.mockResolvedValueOnce({
        emailVerified: true,
        phoneNumber: PHONE_NUMBER,
        phoneVerifiedAt: null,
        hasOnboarded: true,
        isOwnerDriver: false,
        fleetOwnerStatus: FleetOwnerStatus.APPROVED,
        bankDetails: {
          bankName: "GTBank",
          accountName: "JOHN DOE",
          accountNumber: "0123456789",
          isVerified: true,
        },
        documents: [],
        accountVerifications: [succeededRecord()],
      });

      await expect(service.getStatus(USER_ID)).resolves.toMatchObject({
        status: "ACTION_REQUIRED",
        requiredActions: ["VERIFY_PHONE"],
      });
    });

    it("asks for account verification again after a failed attempt", async () => {
      databaseService.user.findUnique.mockResolvedValueOnce({
        emailVerified: true,
        phoneNumber: PHONE_NUMBER,
        phoneVerifiedAt: new Date(),
        hasOnboarded: false,
        isOwnerDriver: false,
        fleetOwnerStatus: FleetOwnerStatus.PROCESSING,
        bankDetails: null,
        documents: [],
        accountVerifications: [processingRecord({ status: AccountVerificationStatus.FAILED })],
      });

      await expect(service.getStatus(USER_ID)).resolves.toMatchObject({
        status: "ACTION_REQUIRED",
        requiredActions: ["VERIFY_ACCOUNT"],
      });
    });

    it("fails closed when the user row is missing", async () => {
      databaseService.user.findUnique.mockResolvedValueOnce(null);

      await expect(service.getStatus(USER_ID)).rejects.toBeInstanceOf(
        AccountVerificationOperationFailedException,
      );
    });
  });

  describe("approve", () => {
    const pendingReview = succeededRecord({
      status: AccountVerificationStatus.REVIEW_REQUIRED,
      isOwnerDriver: true,
      user: { emailVerified: true, phoneVerifiedAt: new Date() },
    });

    const reviewTx = (
      overrides: {
        verification?: unknown;
        completed?: unknown;
        license?: { status: DocumentStatus } | null;
        updateCount?: number;
        bankCount?: number;
      } = {},
    ) => ({
      fleetOwnerAccountVerification: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(
            overrides.verification === undefined ? pendingReview : overrides.verification,
          )
          .mockResolvedValueOnce(
            overrides.completed ??
              succeededRecord({
                reviewedById: REVIEWER_ID,
                reviewedAt: new Date("2026-09-07T00:00:00Z"),
              }),
          ),
        updateMany: vi.fn().mockResolvedValue({ count: overrides.updateCount ?? 1 }),
      },
      documentApproval: {
        findUnique: vi
          .fn()
          .mockResolvedValue(
            overrides.license === undefined
              ? { status: DocumentStatus.APPROVED }
              : overrides.license,
          ),
      },
      bankDetails: {
        updateMany: vi.fn().mockResolvedValue({ count: overrides.bankCount ?? 1 }),
      },
      user: { update: vi.fn() },
    });

    it("approves a pending review after confirming an approved owner-driver licence", async () => {
      const tx = reviewTx();
      databaseService.$transaction.mockImplementationOnce(async (callback) => callback(tx));

      await expect(service.approve(VERIFICATION_ID, REVIEWER_ID)).resolves.toMatchObject({
        id: VERIFICATION_ID,
        status: AccountVerificationStatus.SUCCEEDED,
      });
      expect(tx.fleetOwnerAccountVerification.updateMany).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID, status: AccountVerificationStatus.REVIEW_REQUIRED },
        data: expect.objectContaining({
          status: AccountVerificationStatus.SUCCEEDED,
          reviewedById: REVIEWER_ID,
          reviewedAt: expect.any(Date),
          reviewNotes: null,
        }),
      });
      expect(tx.bankDetails.updateMany).toHaveBeenCalledWith({
        where: { userId: USER_ID },
        data: expect.objectContaining({ isVerified: true }),
      });
      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { hasOnboarded: true, fleetOwnerStatus: FleetOwnerStatus.APPROVED },
      });
    });

    it("rejects approval when the review is not found", async () => {
      const tx = reviewTx({ verification: null });
      databaseService.$transaction.mockImplementationOnce(async (callback) => callback(tx));

      await expect(service.approve(VERIFICATION_ID, REVIEWER_ID)).rejects.toBeInstanceOf(
        AccountVerificationReviewNotFoundException,
      );
    });

    it("rejects approval when the verification is not awaiting review", async () => {
      const tx = reviewTx({
        verification: succeededRecord({
          user: { emailVerified: true, phoneVerifiedAt: new Date() },
        }),
      });
      databaseService.$transaction.mockImplementationOnce(async (callback) => callback(tx));

      await expect(service.approve(VERIFICATION_ID, REVIEWER_ID)).rejects.toBeInstanceOf(
        AccountVerificationReviewNotPendingException,
      );
    });

    it("rejects approval when the owner-driver licence is not approved", async () => {
      const tx = reviewTx({ license: { status: DocumentStatus.PENDING } });
      databaseService.$transaction.mockImplementationOnce(async (callback) => callback(tx));

      await expect(service.approve(VERIFICATION_ID, REVIEWER_ID)).rejects.toBeInstanceOf(
        OwnerDriverLicenseNotApprovedException,
      );
      expect(tx.fleetOwnerAccountVerification.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("reject", () => {
    const reviewTx = (
      verification: { userId: string; status: AccountVerificationStatus } | null = {
        userId: USER_ID,
        status: AccountVerificationStatus.REVIEW_REQUIRED,
      },
    ) => ({
      fleetOwnerAccountVerification: {
        findUnique: vi.fn().mockResolvedValue(verification),
        updateMany: vi.fn().mockResolvedValue({ count: verification ? 1 : 0 }),
      },
      bankDetails: { updateMany: vi.fn() },
      user: { update: vi.fn() },
    });

    it("rejects a pending review, writes audit fields, and holds the owner", async () => {
      const tx = reviewTx();
      databaseService.$transaction.mockImplementationOnce(async (callback) => callback(tx));

      await expect(
        service.reject(VERIFICATION_ID, REVIEWER_ID, "Documents unclear"),
      ).resolves.toEqual({ success: true });
      expect(tx.fleetOwnerAccountVerification.updateMany).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID, status: AccountVerificationStatus.REVIEW_REQUIRED },
        data: expect.objectContaining({
          status: AccountVerificationStatus.FAILED,
          failureReason: AccountVerificationErrorCode.MANUAL_REVIEW_REJECTED,
          reviewedById: REVIEWER_ID,
          reviewedAt: expect.any(Date),
          reviewNotes: "Documents unclear",
        }),
      });
      expect(tx.bankDetails.updateMany).toHaveBeenCalledWith({
        where: { userId: USER_ID },
        data: { isVerified: false },
      });
      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { hasOnboarded: false, fleetOwnerStatus: FleetOwnerStatus.ON_HOLD },
      });
    });

    it("rejects a review that is not pending", async () => {
      const tx = reviewTx({
        userId: USER_ID,
        status: AccountVerificationStatus.SUCCEEDED,
      });
      databaseService.$transaction.mockImplementationOnce(async (callback) => callback(tx));

      await expect(service.reject(VERIFICATION_ID, REVIEWER_ID, "Too late")).rejects.toBeInstanceOf(
        AccountVerificationReviewNotPendingException,
      );
    });

    it("replays a manual-review rejection as the original domain error", async () => {
      databaseService.fleetOwnerAccountVerification.create.mockRejectedValueOnce(
        uniqueConstraintError(),
      );
      databaseService.fleetOwnerAccountVerification.findUnique.mockResolvedValueOnce(
        processingRecord({
          status: AccountVerificationStatus.FAILED,
          failureReason: AccountVerificationErrorCode.MANUAL_REVIEW_REJECTED,
          reviewedById: REVIEWER_ID,
          reviewNotes: "Documents unclear",
        }),
      );

      await expect(
        service.create(USER_ID, IDEMPOTENCY_KEY, individualInput(), {}),
      ).rejects.toBeInstanceOf(AccountManualReviewRejectedException);
    });
  });
});
