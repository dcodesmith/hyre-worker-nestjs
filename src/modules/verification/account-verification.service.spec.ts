import { createHash, createHmac } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import {
  AccountVerificationStage,
  AccountVerificationStatus,
  DocumentStatus,
  DocumentType,
  FleetOwnerAccountType,
  FleetOwnerStatus,
  NameMatchStatus,
  Prisma,
  ProviderVerificationStatus,
} from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { DatabaseService } from "../database/database.service";
import { FlutterwaveError } from "../flutterwave/flutterwave.interface";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";
import type { PremblyDriversLicenseResult } from "../prembly/prembly.interface";
import { PremblyError, PremblyService } from "../prembly/prembly.service";
import { StorageService } from "../storage/storage.service";
import type {
  AccountIdentityVerificationDto,
  CreateAccountVerificationDto,
  DrivingCredentialsDto,
  PayoutVerificationDto,
  UploadedAccountDocument,
} from "./account-verification.dto";
import {
  AccountAlreadyVerifiedException,
  AccountDocumentInvalidException,
  AccountEmailNotVerifiedException,
  AccountManualReviewRejectedException,
  AccountPhoneNotVerifiedException,
  AccountVerificationChangedException,
  AccountVerificationErrorCode,
  AccountVerificationNotFoundException,
  AccountVerificationOperationFailedException,
  AccountVerificationReviewNotFoundException,
  AccountVerificationReviewNotPendingException,
  AccountVerificationReviewPendingException,
  AccountVerificationStepIncompleteException,
  BankAccountNameMismatchException,
  BankAccountProviderUnavailableException,
  BankAccountUnresolvedException,
  BusinessInactiveException,
  BusinessNameMismatchException,
  BusinessOwnerDriverInvalidException,
  CacNotVerifiedException,
  NinNotVerifiedException,
  OwnerDriverLicenseExpiredException,
  OwnerDriverLicenseIdentityMismatchException,
  OwnerDriverLicenseNotApprovedException,
  OwnerDriverLicenseNotVerifiedException,
  OwnerDriverLicenseRequiredException,
} from "./account-verification.error";
import { AccountVerificationService } from "./account-verification.service";
import {
  ProviderVerificationException,
  VerificationIdempotencyKeyReusedException,
  VerificationRequestInProgressException,
} from "./verification.error";

const HMAC_KEY = "test-hmac-key";
const USER_ID = "user-1";
const REVIEWER_ID = "admin-1";
const IDEMPOTENCY_KEY = "account-key-1";
const VERIFICATION_ID = "ver-1";
const STAGE_REQUEST_ID = "stage-req-1";
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

const hashValue = (value: unknown) =>
  createHmac("sha256", HMAC_KEY).update(JSON.stringify(value)).digest("hex");

const fileHash = (file?: UploadedAccountDocument) =>
  file ? createHash("sha256").update(file.buffer).digest("hex") : null;

const requestHash = (
  input: CreateAccountVerificationDto,
  documents: { driversLicense?: UploadedAccountDocument; lasdri?: UploadedAccountDocument } = {},
) =>
  hashValue({
    ...input,
    driversLicense: fileHash(documents.driversLicense),
    lasdri: fileHash(documents.lasdri),
  });

const individualIdentity = (
  overrides: Partial<Extract<AccountIdentityVerificationDto, { accountType: "INDIVIDUAL" }>> = {},
): Extract<AccountIdentityVerificationDto, { accountType: "INDIVIDUAL" }> => ({
  accountType: "INDIVIDUAL",
  nin: "12345678901",
  ...overrides,
});

const businessIdentity = (
  overrides: Partial<Extract<AccountIdentityVerificationDto, { accountType: "BUSINESS" }>> = {},
): Extract<AccountIdentityVerificationDto, { accountType: "BUSINESS" }> => ({
  accountType: "BUSINESS",
  nin: "12345678901",
  businessName: "Hyre Mobility Limited",
  registrationNumber: "RC123456",
  registrationType: "RC",
  ...overrides,
});

const payoutInput = (overrides: Partial<PayoutVerificationDto> = {}): PayoutVerificationDto => ({
  bankName: "GTBank",
  bankCode: "058",
  accountNumber: "0123456789",
  ...overrides,
});

const identityHash = (input: AccountIdentityVerificationDto = individualIdentity()) =>
  hashValue({ stage: "IDENTITY", input });

const payoutHash = (input: PayoutVerificationDto = payoutInput()) =>
  hashValue({ stage: AccountVerificationStage.PAYOUT, input });

const drivingHash = (
  input: DrivingCredentialsDto = { isOwnerDriver: false },
  documents: { driversLicense?: UploadedAccountDocument; lasdri?: UploadedAccountDocument } = {},
) =>
  hashValue({
    stage: AccountVerificationStage.DRIVING,
    input,
    driversLicense: fileHash(documents.driversLicense),
    lasdri: fileHash(documents.lasdri),
  });

const submissionHash = () => hashValue({ stage: AccountVerificationStage.SUBMISSION });

const LICENSE_NUMBER = "ABC12345DE67";

const identity = {
  firstName: "JOHN",
  middleName: "MIDDLE",
  lastName: "DOE",
  reference: "nin-ref",
};

const driversLicense: PremblyDriversLicenseResult = {
  licenseNumber: LICENSE_NUMBER,
  firstName: "JOHN",
  lastName: "DOE",
  middleName: null,
  dateOfBirth: new Date(Date.UTC(1990, 0, 1)),
  expiresAt: new Date(Date.UTC(2099, 11, 31)),
  officialPhoto: "photo",
  reference: "lic-ref",
};

const hashLicenseNumber = (licenseNumber = LICENSE_NUMBER) =>
  createHmac("sha256", HMAC_KEY).update(licenseNumber).digest("hex");

const persistedLicenseData = {
  driversLicenseHash: hashLicenseNumber(),
  driversLicenseLast4: LICENSE_NUMBER.slice(-4).toUpperCase(),
  driversLicenseExpiresAt: driversLicense.expiresAt,
  driversLicenseProviderRef: driversLicense.reference,
};

const clearedLicenseData = {
  driversLicenseHash: null,
  driversLicenseLast4: null,
  driversLicenseExpiresAt: null,
  driversLicenseProviderRef: null,
};

const ownerDriverInput = (
  overrides: Partial<Extract<CreateAccountVerificationDto, { accountType: "INDIVIDUAL" }>> = {},
) => individualInput({ isOwnerDriver: true, driversLicenseNumber: LICENSE_NUMBER, ...overrides });

const ownerDriverDriving = (
  overrides: Partial<DrivingCredentialsDto> = {},
): DrivingCredentialsDto => ({
  isOwnerDriver: true,
  driversLicenseNumber: LICENSE_NUMBER,
  ...overrides,
});

const utcStartOfDay = (dayOffset = 0) => {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + dayOffset);
  return date;
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
  identityFirstName: null,
  identityLastName: null,
  identityRequiresReview: false,
  identityVerifiedAt: null,
  payoutVerifiedAt: null,
  ...clearedLicenseData,
  drivingCompletedAt: null,
  submittedAt: null,
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

const draftRecord = (overrides: Record<string, unknown> = {}) =>
  processingRecord({
    status: AccountVerificationStatus.DRAFT,
    requestHash: identityHash(),
    isOwnerDriver: null,
    identityFirstName: "JOHN",
    identityLastName: "DOE",
    legalName: "JOHN MIDDLE DOE",
    identityProviderRef: "nin-ref",
    identityRequiresReview: false,
    identityVerifiedAt: new Date("2026-01-01T00:05:00Z"),
    ...overrides,
  });

const payoutReadyDraft = (overrides: Record<string, unknown> = {}) =>
  draftRecord({
    bankName: "GTBank",
    bankCode: "058",
    accountNumberLast4: "6789",
    accountName: "JOHN DOE",
    bankNameMatch: NameMatchStatus.MATCHED,
    payoutVerifiedAt: new Date("2026-01-01T00:10:00Z"),
    ...overrides,
  });

const drivingReadyDraft = (overrides: Record<string, unknown> = {}) =>
  payoutReadyDraft({
    isOwnerDriver: false,
    drivingCompletedAt: new Date("2026-01-01T00:12:00Z"),
    ...overrides,
  });

const stageRequest = (overrides: Record<string, unknown> = {}) => ({
  id: STAGE_REQUEST_ID,
  verificationId: VERIFICATION_ID,
  stage: AccountVerificationStage.PAYOUT,
  idempotencyKey: IDEMPOTENCY_KEY,
  requestHash: payoutHash(),
  status: ProviderVerificationStatus.SUCCEEDED,
  failureReason: null,
  response: {
    status: "VERIFIED",
    bank: {
      bankName: "GTBank",
      accountName: "JOHN DOE",
      accountNumber: "******6789",
      nameMatch: NameMatchStatus.MATCHED,
    },
  },
  processingExpiresAt: new Date("2026-01-01T00:15:00Z"),
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  ...overrides,
});

describe("AccountVerificationService", () => {
  let service: AccountVerificationService;
  let databaseService: {
    user: {
      findUnique: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    fleetOwnerAccountVerification: {
      create: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    fleetOwnerAccountVerificationStageRequest: {
      create: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    documentApproval: {
      findUnique: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    bankDetails: { upsert: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let logger: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  let premblyService: {
    verifyNin: ReturnType<typeof vi.fn>;
    verifyCac: ReturnType<typeof vi.fn>;
    verifyDriversLicense: ReturnType<typeof vi.fn>;
  };
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
      user: {
        findUnique: vi.fn().mockResolvedValue(readyUser),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      fleetOwnerAccountVerification: {
        create: vi.fn().mockResolvedValue(processingRecord()),
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn().mockResolvedValue(succeededRecord()),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      fleetOwnerAccountVerificationStageRequest: {
        create: vi.fn().mockResolvedValue({ id: STAGE_REQUEST_ID }),
        findFirst: vi.fn().mockResolvedValue(null),
        findUnique: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      documentApproval: {
        findUnique: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
        upsert: vi.fn(),
        update: vi.fn(),
      },
      bankDetails: { upsert: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      $transaction: vi.fn(),
    };
    premblyService = {
      verifyNin: vi.fn().mockResolvedValue(identity),
      verifyCac: vi.fn().mockResolvedValue(cac),
      verifyDriversLicense: vi.fn(),
    };
    flutterwaveService = {
      resolveBankAccount: vi.fn().mockResolvedValue(resolvedAccount),
    };
    storageService = {
      uploadBuffer: vi
        .fn()
        .mockImplementation(async (_buffer: Buffer, key: string, contentType = "") => {
          const canonicalKey = contentType.startsWith("image/")
            ? `${key.replace(/\.[^./]+$/, "")}.webp`
            : key;
          return { key: `stored/${canonicalKey}`, url: `stored/${canonicalKey}` };
        }),
      deleteObjectByKey: vi.fn().mockResolvedValue(undefined),
    };

    databaseService.$transaction.mockImplementation(async (callback) =>
      callback({
        bankDetails: databaseService.bankDetails,
        documentApproval: databaseService.documentApproval,
        user: databaseService.user,
        fleetOwnerAccountVerification: databaseService.fleetOwnerAccountVerification,
        fleetOwnerAccountVerificationStageRequest:
          databaseService.fleetOwnerAccountVerificationStageRequest,
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
          updateMany: databaseService.fleetOwnerAccountVerification.updateMany,
        },
      }),
    );
  };

  const expectNoLicenseLeak = (result: object) => {
    expect(result).not.toHaveProperty("driversLicenseHash");
    expect(result).not.toHaveProperty("driversLicenseLast4");
    expect(result).not.toHaveProperty("driversLicenseNumber");
  };

  const expectDraftNotAdvanced = () => {
    expect(databaseService.fleetOwnerAccountVerification.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: VERIFICATION_ID, status: AccountVerificationStatus.DRAFT },
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
        service.create({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: individualInput(),
          documents: {},
        }),
      ).rejects.toBeInstanceOf(AccountEmailNotVerifiedException);
      expect(premblyService.verifyNin).not.toHaveBeenCalled();
    });

    it("rejects an unverified phone before calling providers", async () => {
      databaseService.user.findUnique.mockResolvedValueOnce({
        ...readyUser,
        phoneVerifiedAt: null,
      });

      await expect(
        service.create({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: individualInput(),
          documents: {},
        }),
      ).rejects.toBeInstanceOf(AccountPhoneNotVerifiedException);
    });

    it("verifies an individual account and returns a masked bank number", async () => {
      const result = await service.create({
        userId: USER_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        input: individualInput(),
        documents: {},
      });

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
      expect(databaseService.fleetOwnerAccountVerification.updateMany).toHaveBeenCalledWith({
        where: {
          id: VERIFICATION_ID,
          status: AccountVerificationStatus.PROCESSING,
          processingExpiresAt: { gt: expect.any(Date) },
        },
        data: { updatedAt: expect.any(Date) },
      });
    });

    it("fences a late combined worker whose PROCESSING lease has already expired", async () => {
      databaseService.fleetOwnerAccountVerification.updateMany.mockImplementation(
        async (args: { where?: { processingExpiresAt?: { gt?: Date; lte?: Date } } }) =>
          args.where?.processingExpiresAt && "gt" in args.where.processingExpiresAt
            ? { count: 0 }
            : { count: 1 },
      );

      await expect(
        service.create({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: individualInput(),
          documents: {},
        }),
      ).rejects.toBeInstanceOf(AccountVerificationChangedException);
      expect(databaseService.bankDetails.upsert).not.toHaveBeenCalled();
      expect(databaseService.user.update).not.toHaveBeenCalled();
      expect(databaseService.documentApproval.upsert).not.toHaveBeenCalled();
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
            updateMany: databaseService.fleetOwnerAccountVerification.updateMany,
          },
        }),
      );

      const result = await service.create({
        userId: USER_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        input: businessInput(),
        documents: {},
      });

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
        service.create({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: individualInput({ isOwnerDriver: true }),
          documents: {},
        }),
      ).rejects.toBeInstanceOf(OwnerDriverLicenseRequiredException);
      expect(premblyService.verifyNin).not.toHaveBeenCalled();
    });

    it("rejects an owner-driver whose existing licence was rejected", async () => {
      databaseService.documentApproval.findUnique.mockResolvedValueOnce({
        status: DocumentStatus.REJECTED,
      });

      await expect(
        service.create({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: individualInput({ isOwnerDriver: true }),
          documents: {},
        }),
      ).rejects.toBeInstanceOf(OwnerDriverLicenseRequiredException);
    });

    it("automatically succeeds when an owner-driver already has an APPROVED licence", async () => {
      databaseService.documentApproval.findUnique.mockResolvedValueOnce({
        status: DocumentStatus.APPROVED,
      });
      premblyService.verifyDriversLicense.mockResolvedValueOnce(driversLicense);

      await expect(
        service.create({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: ownerDriverInput(),
          documents: {},
        }),
      ).resolves.toMatchObject({ status: AccountVerificationStatus.SUCCEEDED });
      expect(premblyService.verifyDriversLicense).toHaveBeenCalledWith(
        LICENSE_NUMBER,
        "JOHN",
        "DOE",
      );
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
      premblyService.verifyDriversLicense.mockResolvedValueOnce(driversLicense);
      mockReviewTransaction(
        succeededRecord({
          status: AccountVerificationStatus.REVIEW_REQUIRED,
          isOwnerDriver: true,
        }),
      );

      await expect(
        service.create({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: ownerDriverInput(),
          documents: {},
        }),
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
        service.create({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: individualInput(),
          documents: {
            driversLicense: licenseFile(),
          },
        }),
      ).rejects.toBeInstanceOf(AccountDocumentInvalidException);
    });

    it("sends a new owner-driver licence to review and leaves the bank unverified", async () => {
      const licence = licenseFile();
      premblyService.verifyDriversLicense.mockResolvedValueOnce(driversLicense);
      mockReviewTransaction(
        succeededRecord({
          status: AccountVerificationStatus.REVIEW_REQUIRED,
          isOwnerDriver: true,
        }),
      );

      const result = await service.create({
        userId: USER_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        input: ownerDriverInput(),
        documents: { driversLicense: licence },
      });

      expect(result.status).toBe(AccountVerificationStatus.REVIEW_REQUIRED);
      expect(storageService.uploadBuffer).toHaveBeenCalledTimes(1);
      expect(storageService.uploadBuffer).toHaveBeenCalledWith(
        licence.buffer,
        expect.stringMatching(
          new RegExp(
            `^fleet-owners/${USER_ID}/account-verifications/${VERIFICATION_ID}/documents/[0-9a-f-]{36}\\.pdf$`,
          ),
        ),
        "application/pdf",
      );
      const stored = (await storageService.uploadBuffer.mock.results[0]?.value) as {
        url: string;
      };
      expect(databaseService.documentApproval.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ documentUrl: stored.url }),
          update: expect.objectContaining({ documentUrl: stored.url }),
        }),
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
      premblyService.verifyDriversLicense.mockResolvedValueOnce(driversLicense);
      mockReviewTransaction(
        succeededRecord({
          status: AccountVerificationStatus.REVIEW_REQUIRED,
          isOwnerDriver: true,
        }),
      );

      await expect(
        service.create({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: ownerDriverInput(),
          documents: {
            driversLicense: licence,
            lasdri,
          },
        }),
      ).resolves.toMatchObject({ status: AccountVerificationStatus.REVIEW_REQUIRED });
      expect(storageService.uploadBuffer).toHaveBeenCalledTimes(2);
    });

    it("rejects a business owner-driver before claiming or calling Prembly", async () => {
      await expect(
        service.create({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: businessInput({ isOwnerDriver: true, driversLicenseNumber: LICENSE_NUMBER }),
          documents: {},
        }),
      ).rejects.toBeInstanceOf(BusinessOwnerDriverInvalidException);
      expect(premblyService.verifyDriversLicense).not.toHaveBeenCalled();
      expect(premblyService.verifyNin).not.toHaveBeenCalled();
      expect(databaseService.fleetOwnerAccountVerification.create).not.toHaveBeenCalled();
    });

    it("persists hashed licence evidence on a one-shot owner-driver create", async () => {
      premblyService.verifyDriversLicense.mockResolvedValueOnce(driversLicense);
      databaseService.fleetOwnerAccountVerification.update.mockResolvedValueOnce(
        succeededRecord({
          status: AccountVerificationStatus.REVIEW_REQUIRED,
          isOwnerDriver: true,
          ...persistedLicenseData,
        }),
      );

      const result = await service.create({
        userId: USER_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        input: ownerDriverInput(),
        documents: { driversLicense: licenseFile() },
      });

      expect(databaseService.fleetOwnerAccountVerification.update).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID },
        data: expect.objectContaining(persistedLicenseData),
      });
      expectNoLicenseLeak(result);
    });

    it("maps a rejected Prembly licence to not-verified without uploading", async () => {
      premblyService.verifyDriversLicense.mockRejectedValueOnce(new PremblyError("REJECTED"));

      await expect(
        service.create({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: ownerDriverInput(),
          documents: { driversLicense: licenseFile() },
        }),
      ).rejects.toBeInstanceOf(OwnerDriverLicenseNotVerifiedException);
      expect(storageService.uploadBuffer).not.toHaveBeenCalled();
      expect(databaseService.fleetOwnerAccountVerification.updateMany).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID, status: AccountVerificationStatus.PROCESSING },
        data: {
          status: AccountVerificationStatus.FAILED,
          failureReason: AccountVerificationErrorCode.DRIVER_LICENSE_NOT_VERIFIED,
        },
      });
    });

    it("maps an unavailable Prembly licence lookup to a provider exception", async () => {
      premblyService.verifyDriversLicense.mockRejectedValueOnce(new PremblyError("UNAVAILABLE"));

      await expect(
        service.create({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: ownerDriverInput(),
          documents: { driversLicense: licenseFile() },
        }),
      ).rejects.toBeInstanceOf(ProviderVerificationException);
      expect(storageService.uploadBuffer).not.toHaveBeenCalled();
    });

    it("rejects an owner-driver without a number after documents are valid", async () => {
      await expect(
        service.create({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: individualInput({ isOwnerDriver: true }),
          documents: { driversLicense: licenseFile() },
        }),
      ).rejects.toBeInstanceOf(OwnerDriverLicenseNotVerifiedException);
      expect(premblyService.verifyDriversLicense).not.toHaveBeenCalled();
      expect(storageService.uploadBuffer).not.toHaveBeenCalled();
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
        service.create({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: individualInput(),
          documents: {},
        }),
      ).resolves.toMatchObject({ status: AccountVerificationStatus.SUCCEEDED });
    });

    it("treats titled person names as an exact match", async () => {
      flutterwaveService.resolveBankAccount.mockResolvedValueOnce({
        ...resolvedAccount,
        accountName: "Mr. John Doe",
      });

      await expect(
        service.create({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: individualInput(),
          documents: {},
        }),
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
            updateMany: databaseService.fleetOwnerAccountVerification.updateMany,
          },
        }),
      );

      const result = await service.create({
        userId: USER_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        input: individualInput(),
        documents: {},
      });

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
        service.create({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: individualInput(),
          documents: {},
        }),
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
        service.create({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: businessInput(),
          documents: {},
        }),
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
            updateMany: databaseService.fleetOwnerAccountVerification.updateMany,
          },
        }),
      );

      await expect(
        service.create({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: businessInput({ businessName: "Hyre Mobility Limited" }),
          documents: {},
        }),
      ).resolves.toMatchObject({ status: AccountVerificationStatus.REVIEW_REQUIRED });
    });

    it("rejects a mismatched supplied business name", async () => {
      premblyService.verifyCac.mockResolvedValueOnce({
        ...cac,
        businessName: "ACME LOGISTICS PLC",
      });

      await expect(
        service.create({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: businessInput(),
          documents: {},
        }),
      ).rejects.toBeInstanceOf(BusinessNameMismatchException);
    });

    it("rejects an inactive CAC record", async () => {
      premblyService.verifyCac.mockResolvedValueOnce({ ...cac, status: "INACTIVE" });

      await expect(
        service.create({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: businessInput(),
          documents: {},
        }),
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
            updateMany: databaseService.fleetOwnerAccountVerification.updateMany,
          },
        }),
      );

      await expect(
        service.create({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: businessInput(),
          documents: {},
        }),
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
            updateMany: databaseService.fleetOwnerAccountVerification.updateMany,
          },
        }),
      );

      await expect(
        service.create({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: businessInput(),
          documents: {},
        }),
      ).resolves.toMatchObject({ status: AccountVerificationStatus.REVIEW_REQUIRED });
    });

    it("replays a review-required request with the same idempotency key", async () => {
      const replay = succeededRecord({ status: AccountVerificationStatus.REVIEW_REQUIRED });
      databaseService.fleetOwnerAccountVerification.create.mockRejectedValueOnce(
        uniqueConstraintError(),
      );
      databaseService.fleetOwnerAccountVerification.findUnique.mockResolvedValueOnce(replay);

      await expect(
        service.create({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: individualInput(),
          documents: {},
        }),
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
        service.create({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: individualInput(),
          documents: {},
        }),
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
        service.create({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: individualInput(),
          documents: {},
        }),
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
        service.create({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: individualInput(),
          documents: {},
        }),
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
        service.create({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: individualInput(),
          documents: {},
        }),
      ).rejects.toBeInstanceOf(BankAccountNameMismatchException);
    });

    it("rejects a new key once the account is already verified", async () => {
      databaseService.user.findUnique.mockResolvedValueOnce({
        ...readyUser,
        fleetOwnerStatus: FleetOwnerStatus.APPROVED,
      });
      databaseService.fleetOwnerAccountVerification.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.create({
          userId: USER_ID,
          idempotencyKey: "another-key-1",
          input: individualInput(),
          documents: {},
        }),
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
        service.create({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: individualInput(),
          documents: {},
        }),
      ).resolves.toMatchObject({
        id: VERIFICATION_ID,
        status: AccountVerificationStatus.SUCCEEDED,
      });
    });

    it("maps a rejected NIN to a field-specific failure", async () => {
      premblyService.verifyNin.mockRejectedValueOnce(new PremblyError("REJECTED"));

      await expect(
        service.create({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: individualInput(),
          documents: {},
        }),
      ).rejects.toBeInstanceOf(NinNotVerifiedException);
      expect(databaseService.fleetOwnerAccountVerification.updateMany).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID, status: AccountVerificationStatus.PROCESSING },
        data: {
          status: AccountVerificationStatus.FAILED,
          failureReason: AccountVerificationErrorCode.NIN_NOT_VERIFIED,
        },
      });
    });

    it("maps rejected CAC details to a field-specific failure", async () => {
      premblyService.verifyCac.mockRejectedValueOnce(new PremblyError("REJECTED"));

      await expect(
        service.create({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: businessInput(),
          documents: {},
        }),
      ).rejects.toBeInstanceOf(CacNotVerifiedException);
      expect(databaseService.fleetOwnerAccountVerification.updateMany).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID, status: AccountVerificationStatus.PROCESSING },
        data: {
          status: AccountVerificationStatus.FAILED,
          failureReason: AccountVerificationErrorCode.CAC_NOT_VERIFIED,
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
          service.create({
            userId: USER_ID,
            idempotencyKey: IDEMPOTENCY_KEY,
            input: individualInput(),
            documents: {},
          }),
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
          service.create({
            userId: USER_ID,
            idempotencyKey: IDEMPOTENCY_KEY,
            input: individualInput(),
            documents: {},
          }),
        ).rejects.toBeInstanceOf(BankAccountProviderUnavailableException);
      },
    );

    it("deletes uploaded documents when verification fails after storage", async () => {
      const licence = licenseFile();
      premblyService.verifyDriversLicense.mockResolvedValueOnce(driversLicense);
      databaseService.$transaction.mockRejectedValueOnce(new Error("db write failed"));

      await expect(
        service.create({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: ownerDriverInput(),
          documents: {
            driversLicense: licence,
          },
        }),
      ).rejects.toBeInstanceOf(AccountVerificationOperationFailedException);
      const requestedKey = storageService.uploadBuffer.mock.calls[0]?.[1] as string;
      const stored = (await storageService.uploadBuffer.mock.results[0]?.value) as {
        key: string;
        url: string;
      };
      expect(stored.key).not.toBe(requestedKey);
      expect(storageService.deleteObjectByKey).toHaveBeenCalledWith(stored.key);
      expect(storageService.deleteObjectByKey).not.toHaveBeenCalledWith(requestedKey);
      expect(storageService.deleteObjectByKey).not.toHaveBeenCalledWith(
        `https://cdn.test/${requestedKey}`,
      );
    });

    it("retries document cleanup three times and logs after repeated failure", async () => {
      const licence = licenseFile();
      premblyService.verifyDriversLicense.mockResolvedValueOnce(driversLicense);
      databaseService.$transaction.mockRejectedValueOnce(new Error("db write failed"));
      storageService.deleteObjectByKey.mockRejectedValue(new Error("s3 down"));

      await expect(
        service.create({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: ownerDriverInput(),
          documents: {
            driversLicense: licence,
          },
        }),
      ).rejects.toBeInstanceOf(AccountVerificationOperationFailedException);
      expect(storageService.deleteObjectByKey).toHaveBeenCalledTimes(3);
      expect(logger.warn).toHaveBeenCalledWith(
        { err: expect.objectContaining({ message: "s3 down" }) },
        "Failed to delete an unreferenced account document after retries",
      );
    });

    it("fails stale PROCESSING attempts before claiming a new request", async () => {
      await service.create({
        userId: USER_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        input: individualInput(),
        documents: {},
      });

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
        service.create({
          userId: USER_ID,
          idempotencyKey: "other-key-1",
          input: individualInput(),
          documents: {},
        }),
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
        service.create({
          userId: USER_ID,
          idempotencyKey: "other-key-1",
          input: individualInput(),
          documents: {},
        }),
      ).rejects.toBeInstanceOf(AccountVerificationReviewPendingException);
    });

    it("deletes replaced previous documents after a successful re-upload", async () => {
      const licence = licenseFile();
      premblyService.verifyDriversLicense.mockResolvedValueOnce(driversLicense);
      databaseService.documentApproval.findMany.mockResolvedValueOnce([
        { documentType: DocumentType.DRIVERS_LICENSE, documentUrl: "old-license-key" },
      ]);

      await service.create({
        userId: USER_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        input: ownerDriverInput(),
        documents: {
          driversLicense: licence,
        },
      });

      expect(storageService.deleteObjectByKey).toHaveBeenCalledWith("old-license-key");
    });
  });

  describe("staged onboarding", () => {
    it("walks an individual non-driver from identity through payout, driving, and approval", async () => {
      databaseService.fleetOwnerAccountVerification.update.mockResolvedValueOnce(draftRecord());

      await expect(
        service.verifyIdentityStage(USER_ID, IDEMPOTENCY_KEY, individualIdentity()),
      ).resolves.toMatchObject({ status: "VERIFIED", legalName: "JOHN MIDDLE DOE" });
      expect(premblyService.verifyNin).toHaveBeenCalledWith("12345678901");
      expect(premblyService.verifyCac).not.toHaveBeenCalled();
      expect(databaseService.fleetOwnerAccountVerification.update).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID },
        data: expect.objectContaining({
          status: AccountVerificationStatus.DRAFT,
          identityVerifiedAt: expect.any(Date),
          identityFirstName: "JOHN",
          identityLastName: "DOE",
        }),
      });

      databaseService.fleetOwnerAccountVerification.findFirst.mockResolvedValue(draftRecord());
      await expect(
        service.verifyPayoutStage(USER_ID, "payout-key-1", payoutInput()),
      ).resolves.toMatchObject({
        status: "VERIFIED",
        bank: { nameMatch: NameMatchStatus.MATCHED, accountNumber: "******6789" },
      });
      expect(flutterwaveService.resolveBankAccount).toHaveBeenCalledWith("058", "0123456789");
      expect(databaseService.fleetOwnerAccountVerification.updateMany).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID, status: AccountVerificationStatus.DRAFT },
        data: expect.objectContaining({
          bankNameMatch: NameMatchStatus.MATCHED,
          payoutVerifiedAt: expect.any(Date),
        }),
      });

      databaseService.fleetOwnerAccountVerification.findFirst.mockResolvedValue(payoutReadyDraft());
      await expect(
        service.saveDrivingCredentialsStage({
          userId: USER_ID,
          idempotencyKey: "driving-key-1",
          input: { isOwnerDriver: false },
          documents: {},
        }),
      ).resolves.toMatchObject({ status: "COMPLETED", isOwnerDriver: false });
      expect(databaseService.fleetOwnerAccountVerification.updateMany).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID, status: AccountVerificationStatus.DRAFT },
        data: {
          isOwnerDriver: false,
          ...clearedLicenseData,
          drivingCompletedAt: expect.any(Date),
        },
      });

      databaseService.fleetOwnerAccountVerification.findFirst.mockResolvedValue(
        drivingReadyDraft(),
      );
      databaseService.fleetOwnerAccountVerification.findUnique.mockResolvedValueOnce(
        drivingReadyDraft(),
      );
      databaseService.fleetOwnerAccountVerification.update.mockResolvedValueOnce(
        succeededRecord({
          submittedAt: new Date("2026-01-01T00:15:00Z"),
          drivingCompletedAt: new Date("2026-01-01T00:12:00Z"),
        }),
      );
      await expect(service.submitStage(USER_ID, "submit-key-1")).resolves.toMatchObject({
        status: AccountVerificationStatus.SUCCEEDED,
      });
      expect(databaseService.user.updateMany).toHaveBeenCalledWith({
        where: { id: USER_ID, emailVerified: true, phoneVerifiedAt: { not: null } },
        data: expect.objectContaining({
          fleetOwnerStatus: FleetOwnerStatus.APPROVED,
          hasOnboarded: true,
          isOwnerDriver: false,
        }),
      });
      expect(premblyService.verifyNin).toHaveBeenCalledTimes(1);
      expect(flutterwaveService.resolveBankAccount).toHaveBeenCalledTimes(1);
    });
  });

  describe("verifyIdentityStage", () => {
    it("verifies an individual non-driver identity and persists DRAFT timestamps", async () => {
      const completed = draftRecord();
      databaseService.fleetOwnerAccountVerification.update.mockResolvedValueOnce(completed);

      await expect(
        service.verifyIdentityStage(USER_ID, IDEMPOTENCY_KEY, individualIdentity()),
      ).resolves.toEqual({
        id: VERIFICATION_ID,
        status: "VERIFIED",
        accountType: FleetOwnerAccountType.INDIVIDUAL,
        legalName: "JOHN MIDDLE DOE",
        businessName: null,
      });
      expect(premblyService.verifyNin).toHaveBeenCalledWith("12345678901");
      expect(premblyService.verifyCac).not.toHaveBeenCalled();
      expect(flutterwaveService.resolveBankAccount).not.toHaveBeenCalled();
      expect(databaseService.fleetOwnerAccountVerification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          requestHash: identityHash(),
          accountType: FleetOwnerAccountType.INDIVIDUAL,
          isOwnerDriver: undefined,
        }),
      });
      expect(databaseService.bankDetails.updateMany).toHaveBeenCalledWith({
        where: { userId: USER_ID },
        data: { isVerified: false },
      });
      const persisted = databaseService.fleetOwnerAccountVerification.update.mock.calls[0]?.[0];
      expect(persisted).toEqual({
        where: { id: VERIFICATION_ID },
        data: expect.objectContaining({
          status: AccountVerificationStatus.DRAFT,
          identityFirstName: "JOHN",
          identityLastName: "DOE",
          legalName: "JOHN MIDDLE DOE",
          identityProviderRef: "nin-ref",
          identityRequiresReview: false,
          identityVerifiedAt: expect.any(Date),
        }),
      });
      expect(persisted?.data.isOwnerDriver).toBeUndefined();
      expect(persisted?.data.drivingCompletedAt).toBeUndefined();
      expect(databaseService.fleetOwnerAccountVerification.updateMany).toHaveBeenCalledWith({
        where: {
          id: VERIFICATION_ID,
          status: AccountVerificationStatus.PROCESSING,
          processingExpiresAt: { gt: expect.any(Date) },
        },
        data: { updatedAt: expect.any(Date) },
      });
    });

    it("fences a late identity worker whose PROCESSING lease has already expired", async () => {
      databaseService.fleetOwnerAccountVerification.updateMany.mockImplementation(
        async (args: { where?: { processingExpiresAt?: { gt?: Date; lte?: Date } } }) =>
          args.where?.processingExpiresAt && "gt" in args.where.processingExpiresAt
            ? { count: 0 }
            : { count: 1 },
      );

      await expect(
        service.verifyIdentityStage(USER_ID, IDEMPOTENCY_KEY, individualIdentity()),
      ).rejects.toBeInstanceOf(AccountVerificationChangedException);
      expect(databaseService.bankDetails.updateMany).not.toHaveBeenCalled();
      expect(databaseService.fleetOwnerAccountVerification.update).not.toHaveBeenCalled();
    });

    it("verifies a business representative, skips driving, and marks the draft complete for driving", async () => {
      const completed = draftRecord({
        accountType: FleetOwnerAccountType.BUSINESS,
        businessName: "HYRE MOBILITY LTD",
        registrationNumber: "RC123456",
        registrationType: "RC",
        businessProviderRef: "cac-ref",
        businessNameMatch: NameMatchStatus.MATCHED,
        representativeNameMatch: NameMatchStatus.MATCHED,
        isOwnerDriver: false,
        drivingCompletedAt: new Date("2026-01-01T00:05:00Z"),
      });
      databaseService.fleetOwnerAccountVerification.update.mockResolvedValueOnce(completed);

      await expect(
        service.verifyIdentityStage(USER_ID, IDEMPOTENCY_KEY, businessIdentity()),
      ).resolves.toMatchObject({
        status: "VERIFIED",
        accountType: FleetOwnerAccountType.BUSINESS,
        legalName: "JOHN MIDDLE DOE",
        businessName: "HYRE MOBILITY LTD",
      });
      expect(premblyService.verifyCac).toHaveBeenCalledWith(
        "RC123456",
        "RC",
        "Hyre Mobility Limited",
      );
      expect(databaseService.fleetOwnerAccountVerification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          accountType: FleetOwnerAccountType.BUSINESS,
          isOwnerDriver: false,
        }),
      });
      expect(databaseService.fleetOwnerAccountVerification.update).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID },
        data: expect.objectContaining({
          status: AccountVerificationStatus.DRAFT,
          isOwnerDriver: false,
          drivingCompletedAt: expect.any(Date),
          representativeNameMatch: NameMatchStatus.MATCHED,
          businessNameMatch: NameMatchStatus.MATCHED,
          identityRequiresReview: false,
        }),
      });
    });

    it("keeps a rejected NIN on the identity claim and marks PROCESSING failed", async () => {
      premblyService.verifyNin.mockRejectedValueOnce(new PremblyError("REJECTED"));

      await expect(
        service.verifyIdentityStage(USER_ID, IDEMPOTENCY_KEY, individualIdentity()),
      ).rejects.toBeInstanceOf(NinNotVerifiedException);
      expect(databaseService.fleetOwnerAccountVerification.updateMany).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID, status: AccountVerificationStatus.PROCESSING },
        data: {
          status: AccountVerificationStatus.FAILED,
          failureReason: AccountVerificationErrorCode.NIN_NOT_VERIFIED,
        },
      });
      expect(databaseService.fleetOwnerAccountVerification.update).not.toHaveBeenCalled();
    });

    it("keeps rejected CAC details on the identity claim", async () => {
      premblyService.verifyCac.mockRejectedValueOnce(new PremblyError("REJECTED"));

      await expect(
        service.verifyIdentityStage(USER_ID, IDEMPOTENCY_KEY, businessIdentity()),
      ).rejects.toBeInstanceOf(CacNotVerifiedException);
      expect(databaseService.fleetOwnerAccountVerification.updateMany).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID, status: AccountVerificationStatus.PROCESSING },
        data: {
          status: AccountVerificationStatus.FAILED,
          failureReason: AccountVerificationErrorCode.CAC_NOT_VERIFIED,
        },
      });
    });

    it("replays a completed identity request with the same idempotency key", async () => {
      const replay = draftRecord();
      databaseService.fleetOwnerAccountVerification.create.mockRejectedValueOnce(
        uniqueConstraintError(),
      );
      databaseService.fleetOwnerAccountVerification.findUnique.mockResolvedValueOnce(replay);

      await expect(
        service.verifyIdentityStage(USER_ID, IDEMPOTENCY_KEY, individualIdentity()),
      ).resolves.toEqual({
        id: VERIFICATION_ID,
        status: "VERIFIED",
        accountType: FleetOwnerAccountType.INDIVIDUAL,
        legalName: "JOHN MIDDLE DOE",
        businessName: null,
      });
      expect(premblyService.verifyNin).not.toHaveBeenCalled();
    });

    it("rejects the same identity idempotency key used with a different payload", async () => {
      databaseService.fleetOwnerAccountVerification.create.mockRejectedValueOnce(
        uniqueConstraintError(),
      );
      databaseService.fleetOwnerAccountVerification.findUnique.mockResolvedValueOnce(
        draftRecord({ requestHash: "other-hash" }),
      );

      await expect(
        service.verifyIdentityStage(USER_ID, IDEMPOTENCY_KEY, individualIdentity()),
      ).rejects.toBeInstanceOf(VerificationIdempotencyKeyReusedException);
    });

    it("rejects an in-progress identity replay", async () => {
      databaseService.fleetOwnerAccountVerification.create.mockRejectedValueOnce(
        uniqueConstraintError(),
      );
      databaseService.fleetOwnerAccountVerification.findUnique.mockResolvedValueOnce(
        processingRecord({ requestHash: identityHash() }),
      );

      await expect(
        service.verifyIdentityStage(USER_ID, IDEMPOTENCY_KEY, individualIdentity()),
      ).rejects.toBeInstanceOf(VerificationRequestInProgressException);
    });
  });

  describe("verifyPayoutStage", () => {
    beforeEach(() => {
      databaseService.fleetOwnerAccountVerification.findFirst.mockResolvedValue(draftRecord());
    });

    it("resolves an individual payout, matches the verified name, and persists payout timestamps", async () => {
      await expect(
        service.verifyPayoutStage(USER_ID, IDEMPOTENCY_KEY, payoutInput()),
      ).resolves.toEqual({
        status: "VERIFIED",
        bank: {
          bankName: "GTBank",
          accountName: "JOHN DOE",
          accountNumber: "******6789",
          nameMatch: NameMatchStatus.MATCHED,
        },
      });
      expect(flutterwaveService.resolveBankAccount).toHaveBeenCalledWith("058", "0123456789");
      expect(databaseService.bankDetails.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            isVerified: false,
            accountName: "JOHN DOE",
            accountNumber: "0123456789",
          }),
          update: expect.objectContaining({ isVerified: false }),
        }),
      );
      expect(
        databaseService.fleetOwnerAccountVerificationStageRequest.updateMany,
      ).toHaveBeenCalledWith({
        where: {
          verificationId: VERIFICATION_ID,
          stage: AccountVerificationStage.PAYOUT,
          status: ProviderVerificationStatus.PROCESSING,
          processingExpiresAt: { lte: expect.any(Date) },
        },
        data: {
          status: ProviderVerificationStatus.FAILED,
          failureReason: AccountVerificationErrorCode.VERIFICATION_CHANGED,
        },
      });
      expect(
        databaseService.fleetOwnerAccountVerificationStageRequest.updateMany,
      ).toHaveBeenCalledWith({
        where: {
          id: STAGE_REQUEST_ID,
          status: ProviderVerificationStatus.PROCESSING,
          processingExpiresAt: { gt: expect.any(Date) },
        },
        data: { updatedAt: expect.any(Date) },
      });
      const persisted = databaseService.fleetOwnerAccountVerification.updateMany.mock.calls.find(
        ([args]) => args.where?.status === AccountVerificationStatus.DRAFT,
      )?.[0];
      expect(persisted).toEqual({
        where: { id: VERIFICATION_ID, status: AccountVerificationStatus.DRAFT },
        data: expect.objectContaining({
          bankName: "GTBank",
          bankCode: "058",
          accountNumberLast4: "6789",
          accountName: "JOHN DOE",
          bankNameMatch: NameMatchStatus.MATCHED,
          payoutVerifiedAt: expect.any(Date),
        }),
      });
      expect(persisted?.data).not.toHaveProperty("payoutRequiresReview");
      expect(databaseService.fleetOwnerAccountVerificationStageRequest.update).toHaveBeenCalledWith(
        {
          where: { id: STAGE_REQUEST_ID },
          data: expect.objectContaining({ status: ProviderVerificationStatus.SUCCEEDED }),
        },
      );
    });

    it("matches a business payout against the verified company name", async () => {
      databaseService.fleetOwnerAccountVerification.findFirst.mockResolvedValue(
        draftRecord({
          accountType: FleetOwnerAccountType.BUSINESS,
          businessName: "HYRE MOBILITY LTD",
        }),
      );
      flutterwaveService.resolveBankAccount.mockResolvedValueOnce({
        ...resolvedAccount,
        accountName: "HYRE MOBILITY LIMITED",
      });

      await expect(
        service.verifyPayoutStage(USER_ID, IDEMPOTENCY_KEY, payoutInput()),
      ).resolves.toMatchObject({
        status: "VERIFIED",
        bank: { nameMatch: NameMatchStatus.MATCHED, accountName: "HYRE MOBILITY LIMITED" },
      });
    });

    it("rejects payout before identity has created a draft", async () => {
      databaseService.fleetOwnerAccountVerification.findFirst.mockResolvedValue(null);

      await expect(
        service.verifyPayoutStage(USER_ID, IDEMPOTENCY_KEY, payoutInput()),
      ).rejects.toBeInstanceOf(AccountVerificationNotFoundException);
      expect(flutterwaveService.resolveBankAccount).not.toHaveBeenCalled();
    });

    it("rejects payout when the draft has not completed identity", async () => {
      databaseService.fleetOwnerAccountVerification.findFirst.mockResolvedValue(
        draftRecord({ identityVerifiedAt: null }),
      );

      await expect(
        service.verifyPayoutStage(USER_ID, IDEMPOTENCY_KEY, payoutInput()),
      ).rejects.toBeInstanceOf(AccountVerificationStepIncompleteException);
      expect(flutterwaveService.resolveBankAccount).not.toHaveBeenCalled();
    });

    it("keeps an unresolved bank account on the payout stage", async () => {
      flutterwaveService.resolveBankAccount.mockRejectedValueOnce(
        new FlutterwaveError("Account not found", "ACCOUNT_NOT_FOUND", 404),
      );

      await expect(
        service.verifyPayoutStage(USER_ID, IDEMPOTENCY_KEY, payoutInput()),
      ).rejects.toBeInstanceOf(BankAccountUnresolvedException);
      expect(
        databaseService.fleetOwnerAccountVerificationStageRequest.updateMany,
      ).toHaveBeenCalledWith({
        where: { id: STAGE_REQUEST_ID, status: ProviderVerificationStatus.PROCESSING },
        data: {
          status: ProviderVerificationStatus.FAILED,
          failureReason: AccountVerificationErrorCode.BANK_ACCOUNT_UNRESOLVED,
        },
      });
      expect(databaseService.fleetOwnerAccountVerification.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: VERIFICATION_ID, status: AccountVerificationStatus.DRAFT },
        }),
      );
    });

    it("keeps a mismatched bank name on the payout stage", async () => {
      flutterwaveService.resolveBankAccount.mockResolvedValueOnce({
        ...resolvedAccount,
        accountName: "JANE SMITH",
      });

      await expect(
        service.verifyPayoutStage(USER_ID, IDEMPOTENCY_KEY, payoutInput()),
      ).rejects.toBeInstanceOf(BankAccountNameMismatchException);
      expect(
        databaseService.fleetOwnerAccountVerificationStageRequest.updateMany,
      ).toHaveBeenCalledWith({
        where: { id: STAGE_REQUEST_ID, status: ProviderVerificationStatus.PROCESSING },
        data: {
          status: ProviderVerificationStatus.FAILED,
          failureReason: AccountVerificationErrorCode.BANK_ACCOUNT_NAME_MISMATCH,
        },
      });
      expect(databaseService.fleetOwnerAccountVerification.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: VERIFICATION_ID, status: AccountVerificationStatus.DRAFT },
        }),
      );
    });

    it("replays a succeeded payout request with the same idempotency key", async () => {
      const replay = stageRequest();
      databaseService.fleetOwnerAccountVerificationStageRequest.findUnique.mockResolvedValueOnce(
        replay,
      );

      await expect(
        service.verifyPayoutStage(USER_ID, IDEMPOTENCY_KEY, payoutInput()),
      ).resolves.toEqual(replay.response);
      expect(flutterwaveService.resolveBankAccount).not.toHaveBeenCalled();
      expect(databaseService.fleetOwnerAccountVerification.findFirst).toHaveBeenCalledWith({
        where: { userId: USER_ID },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      expect(
        databaseService.fleetOwnerAccountVerificationStageRequest.create,
      ).not.toHaveBeenCalled();
    });

    it("rejects the same payout idempotency key used with a different payload", async () => {
      databaseService.fleetOwnerAccountVerificationStageRequest.findUnique.mockResolvedValueOnce(
        stageRequest({ requestHash: "other-hash" }),
      );

      await expect(
        service.verifyPayoutStage(USER_ID, IDEMPOTENCY_KEY, payoutInput()),
      ).rejects.toBeInstanceOf(VerificationIdempotencyKeyReusedException);
    });

    it("rejects a changed payout payload on an expired PROCESSING key without mutating expiry", async () => {
      databaseService.fleetOwnerAccountVerificationStageRequest.findUnique.mockResolvedValueOnce(
        stageRequest({
          status: ProviderVerificationStatus.PROCESSING,
          requestHash: "other-hash",
          processingExpiresAt: new Date("2025-12-31T23:59:00Z"),
        }),
      );

      await expect(
        service.verifyPayoutStage(USER_ID, IDEMPOTENCY_KEY, payoutInput()),
      ).rejects.toBeInstanceOf(VerificationIdempotencyKeyReusedException);
      expect(
        databaseService.fleetOwnerAccountVerificationStageRequest.updateMany,
      ).not.toHaveBeenCalled();
    });

    it("rejects an in-progress payout replay", async () => {
      databaseService.fleetOwnerAccountVerificationStageRequest.findUnique.mockResolvedValueOnce(
        stageRequest({
          status: ProviderVerificationStatus.PROCESSING,
          processingExpiresAt: new Date("2026-12-31T00:00:00Z"),
        }),
      );

      await expect(
        service.verifyPayoutStage(USER_ID, IDEMPOTENCY_KEY, payoutInput()),
      ).rejects.toBeInstanceOf(VerificationRequestInProgressException);
    });

    it("rejects payout when the owner's phone is no longer verified, before replay", async () => {
      databaseService.user.findUnique.mockResolvedValueOnce({
        ...readyUser,
        phoneVerifiedAt: null,
      });
      databaseService.fleetOwnerAccountVerificationStageRequest.findUnique.mockResolvedValueOnce(
        stageRequest(),
      );

      await expect(
        service.verifyPayoutStage(USER_ID, IDEMPOTENCY_KEY, payoutInput()),
      ).rejects.toBeInstanceOf(AccountPhoneNotVerifiedException);
      expect(databaseService.fleetOwnerAccountVerification.findFirst).not.toHaveBeenCalled();
      expect(
        databaseService.fleetOwnerAccountVerificationStageRequest.findUnique,
      ).not.toHaveBeenCalled();
      expect(flutterwaveService.resolveBankAccount).not.toHaveBeenCalled();
    });

    it("rejects a stale draft that is no longer DRAFT during payout", async () => {
      databaseService.fleetOwnerAccountVerification.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(
        service.verifyPayoutStage(USER_ID, IDEMPOTENCY_KEY, payoutInput()),
      ).rejects.toBeInstanceOf(AccountVerificationChangedException);
      expect(
        databaseService.fleetOwnerAccountVerificationStageRequest.updateMany,
      ).toHaveBeenCalledWith({
        where: { id: STAGE_REQUEST_ID, status: ProviderVerificationStatus.PROCESSING },
        data: {
          status: ProviderVerificationStatus.FAILED,
          failureReason: AccountVerificationErrorCode.VERIFICATION_CHANGED,
        },
      });
    });

    it("fences a late payout worker whose PROCESSING lease has already expired", async () => {
      databaseService.fleetOwnerAccountVerificationStageRequest.updateMany
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 0 });

      await expect(
        service.verifyPayoutStage(USER_ID, IDEMPOTENCY_KEY, payoutInput()),
      ).rejects.toBeInstanceOf(AccountVerificationChangedException);
      expect(databaseService.bankDetails.upsert).not.toHaveBeenCalled();
    });

    it("fails an expired same-key PROCESSING payout before a new claim", async () => {
      databaseService.fleetOwnerAccountVerificationStageRequest.findUnique.mockResolvedValueOnce(
        stageRequest({
          status: ProviderVerificationStatus.PROCESSING,
          processingExpiresAt: new Date("2025-12-31T23:59:00Z"),
        }),
      );

      await expect(
        service.verifyPayoutStage(USER_ID, IDEMPOTENCY_KEY, payoutInput()),
      ).rejects.toBeInstanceOf(AccountVerificationChangedException);
      expect(
        databaseService.fleetOwnerAccountVerificationStageRequest.updateMany,
      ).toHaveBeenCalledWith({
        where: {
          id: STAGE_REQUEST_ID,
          status: ProviderVerificationStatus.PROCESSING,
          processingExpiresAt: { lte: expect.any(Date) },
        },
        data: {
          status: ProviderVerificationStatus.FAILED,
          failureReason: AccountVerificationErrorCode.VERIFICATION_CHANGED,
        },
      });
      expect(flutterwaveService.resolveBankAccount).not.toHaveBeenCalled();
    });

    it("scopes a payout key to the latest verification attempt", async () => {
      databaseService.fleetOwnerAccountVerification.findFirst
        .mockResolvedValueOnce({ id: "latest-ver" })
        .mockResolvedValueOnce(draftRecord({ id: "latest-ver" }));

      await service.verifyPayoutStage(USER_ID, IDEMPOTENCY_KEY, payoutInput());

      expect(
        databaseService.fleetOwnerAccountVerificationStageRequest.findUnique,
      ).toHaveBeenCalledWith({
        where: {
          verificationId_idempotencyKey: {
            verificationId: "latest-ver",
            idempotencyKey: IDEMPOTENCY_KEY,
          },
        },
      });
      expect(databaseService.fleetOwnerAccountVerificationStageRequest.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ verificationId: "latest-ver" }),
        }),
      );
    });

    it("rejects a payout key that was already used for another stage", async () => {
      databaseService.fleetOwnerAccountVerificationStageRequest.findUnique.mockResolvedValueOnce(
        stageRequest({
          stage: AccountVerificationStage.DRIVING,
          requestHash: drivingHash(),
        }),
      );

      await expect(
        service.verifyPayoutStage(USER_ID, IDEMPOTENCY_KEY, payoutInput()),
      ).rejects.toBeInstanceOf(VerificationIdempotencyKeyReusedException);
      expect(flutterwaveService.resolveBankAccount).not.toHaveBeenCalled();
    });

    it("maps a processing-per-stage collision to an in-progress payout", async () => {
      databaseService.fleetOwnerAccountVerificationStageRequest.create.mockRejectedValueOnce(
        uniqueConstraintError(),
      );
      databaseService.fleetOwnerAccountVerificationStageRequest.findFirst.mockResolvedValueOnce({
        id: "active-payout",
      });

      await expect(
        service.verifyPayoutStage(USER_ID, IDEMPOTENCY_KEY, payoutInput()),
      ).rejects.toBeInstanceOf(VerificationRequestInProgressException);
      expect(flutterwaveService.resolveBankAccount).not.toHaveBeenCalled();
    });

    it("retries once when a processing-per-stage collision disappears before lookup", async () => {
      databaseService.fleetOwnerAccountVerificationStageRequest.create.mockRejectedValueOnce(
        uniqueConstraintError(),
      );

      await expect(
        service.verifyPayoutStage(USER_ID, IDEMPOTENCY_KEY, payoutInput()),
      ).resolves.toMatchObject({ status: "VERIFIED" });
      expect(
        databaseService.fleetOwnerAccountVerificationStageRequest.create,
      ).toHaveBeenCalledTimes(2);
      expect(flutterwaveService.resolveBankAccount).toHaveBeenCalledTimes(1);
    });

    it("replays a changed-workflow payout failure as ACCOUNT_VERIFICATION_CHANGED", async () => {
      databaseService.fleetOwnerAccountVerificationStageRequest.findUnique.mockResolvedValueOnce(
        stageRequest({
          status: ProviderVerificationStatus.FAILED,
          failureReason: AccountVerificationErrorCode.VERIFICATION_CHANGED,
        }),
      );

      await expect(
        service.verifyPayoutStage(USER_ID, IDEMPOTENCY_KEY, payoutInput()),
      ).rejects.toBeInstanceOf(AccountVerificationChangedException);
      expect(flutterwaveService.resolveBankAccount).not.toHaveBeenCalled();
    });
  });

  describe("saveDrivingCredentialsStage", () => {
    beforeEach(() => {
      databaseService.fleetOwnerAccountVerification.findFirst.mockResolvedValue(payoutReadyDraft());
    });

    it("completes driving for an individual non-driver without uploading documents", async () => {
      await expect(
        service.saveDrivingCredentialsStage({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: { isOwnerDriver: false },
          documents: {},
        }),
      ).resolves.toEqual({
        status: "COMPLETED",
        isOwnerDriver: false,
        documents: { driversLicense: null, lasdri: null },
      });
      expect(storageService.uploadBuffer).not.toHaveBeenCalled();
      expect(premblyService.verifyDriversLicense).not.toHaveBeenCalled();
      expect(databaseService.fleetOwnerAccountVerification.updateMany).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID, status: AccountVerificationStatus.DRAFT },
        data: {
          isOwnerDriver: false,
          ...clearedLicenseData,
          drivingCompletedAt: expect.any(Date),
        },
      });
      expect(
        databaseService.fleetOwnerAccountVerificationStageRequest.updateMany,
      ).toHaveBeenCalledWith({
        where: {
          id: STAGE_REQUEST_ID,
          status: ProviderVerificationStatus.PROCESSING,
          processingExpiresAt: { gt: expect.any(Date) },
        },
        data: { updatedAt: expect.any(Date) },
      });
    });

    it("verifies an owner-driver licence with Prembly and persists hashed evidence", async () => {
      premblyService.verifyDriversLicense.mockResolvedValueOnce(driversLicense);

      await expect(
        service.saveDrivingCredentialsStage({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: ownerDriverDriving(),
          documents: { driversLicense: licenseFile() },
        }),
      ).resolves.toMatchObject({
        status: "COMPLETED",
        isOwnerDriver: true,
        documents: { driversLicense: "PENDING" },
      });
      expect(premblyService.verifyDriversLicense).toHaveBeenCalledWith(
        LICENSE_NUMBER,
        "JOHN",
        "DOE",
      );
      expect(databaseService.fleetOwnerAccountVerification.updateMany).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID, status: AccountVerificationStatus.DRAFT },
        data: {
          isOwnerDriver: true,
          ...persistedLicenseData,
          drivingCompletedAt: expect.any(Date),
        },
      });
    });

    it("hashes the typed licence number rather than Prembly's canonical form", async () => {
      const typedNumber = "abc-12345-de67";
      premblyService.verifyDriversLicense.mockResolvedValueOnce({
        ...driversLicense,
        licenseNumber: "ABC12345YZ00",
      });

      await expect(
        service.saveDrivingCredentialsStage({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: ownerDriverDriving({ driversLicenseNumber: typedNumber }),
          documents: { driversLicense: licenseFile() },
        }),
      ).resolves.toMatchObject({ status: "COMPLETED" });
      expect(premblyService.verifyDriversLicense).toHaveBeenCalledWith(
        LICENSE_NUMBER,
        "JOHN",
        "DOE",
      );
      expect(databaseService.fleetOwnerAccountVerification.updateMany).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID, status: AccountVerificationStatus.DRAFT },
        data: expect.objectContaining({
          driversLicenseHash: hashLicenseNumber(LICENSE_NUMBER),
          driversLicenseLast4: "DE67",
        }),
      });
    });

    it("does not delete the new object when the same filename is resubmitted", async () => {
      databaseService.documentApproval.findMany.mockResolvedValueOnce([
        { documentType: DocumentType.DRIVERS_LICENSE, documentUrl: "old-license-key" },
      ]);
      premblyService.verifyDriversLicense.mockResolvedValueOnce(driversLicense);

      await expect(
        service.saveDrivingCredentialsStage({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: ownerDriverDriving(),
          documents: { driversLicense: licenseFile() },
        }),
      ).resolves.toMatchObject({
        status: "COMPLETED",
        isOwnerDriver: true,
        documents: { driversLicense: "PENDING" },
      });

      const requestedKey = storageService.uploadBuffer.mock.calls[0]?.[1] as string;
      const stored = (await storageService.uploadBuffer.mock.results[0]?.value) as {
        key: string;
        url: string;
      };
      expect(requestedKey).toMatch(
        new RegExp(
          `^fleet-owners/${USER_ID}/account-verifications/${VERIFICATION_ID}/documents/[0-9a-f-]{36}\\.pdf$`,
        ),
      );
      expect(databaseService.documentApproval.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ documentUrl: stored.url }),
          update: expect.objectContaining({ documentUrl: stored.url }),
        }),
      );
      expect(storageService.deleteObjectByKey).toHaveBeenCalledWith("old-license-key");
      expect(storageService.deleteObjectByKey).not.toHaveBeenCalledWith(requestedKey);
      expect(storageService.deleteObjectByKey).not.toHaveBeenCalledWith(stored.key);
    });

    it("rejects driving before payout is complete", async () => {
      databaseService.fleetOwnerAccountVerification.findFirst.mockResolvedValue(draftRecord());

      await expect(
        service.saveDrivingCredentialsStage({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: { isOwnerDriver: false },
          documents: {},
        }),
      ).rejects.toBeInstanceOf(AccountVerificationStepIncompleteException);
    });

    it("rejects a missing required owner-driver licence and leaves the draft in place", async () => {
      databaseService.documentApproval.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.saveDrivingCredentialsStage({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: { isOwnerDriver: true },
          documents: {},
        }),
      ).rejects.toBeInstanceOf(OwnerDriverLicenseRequiredException);
      expect(
        databaseService.fleetOwnerAccountVerificationStageRequest.create,
      ).not.toHaveBeenCalled();
      expect(databaseService.fleetOwnerAccountVerification.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: VERIFICATION_ID, status: AccountVerificationStatus.DRAFT },
        }),
      );
    });

    it("rejects owner-driver documents on a business draft", async () => {
      databaseService.fleetOwnerAccountVerification.findFirst.mockResolvedValue(
        payoutReadyDraft({
          accountType: FleetOwnerAccountType.BUSINESS,
          businessName: "HYRE MOBILITY LTD",
          isOwnerDriver: false,
          drivingCompletedAt: new Date("2026-01-01T00:05:00Z"),
        }),
      );

      await expect(
        service.saveDrivingCredentialsStage({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: { isOwnerDriver: true },
          documents: { driversLicense: licenseFile() },
        }),
      ).rejects.toBeInstanceOf(BusinessOwnerDriverInvalidException);
      expect(storageService.uploadBuffer).not.toHaveBeenCalled();
    });

    it("rejects a business draft with a licence number before Prembly", async () => {
      databaseService.fleetOwnerAccountVerification.findFirst.mockResolvedValue(
        payoutReadyDraft({
          accountType: FleetOwnerAccountType.BUSINESS,
          businessName: "HYRE MOBILITY LTD",
        }),
      );

      await expect(
        service.saveDrivingCredentialsStage({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: ownerDriverDriving(),
          documents: {},
        }),
      ).rejects.toBeInstanceOf(BusinessOwnerDriverInvalidException);
      expect(premblyService.verifyDriversLicense).not.toHaveBeenCalled();
      expect(
        databaseService.fleetOwnerAccountVerificationStageRequest.create,
      ).not.toHaveBeenCalled();
    });

    it("replays a completed driving request with the same idempotency key", async () => {
      const replay = stageRequest({
        stage: AccountVerificationStage.DRIVING,
        requestHash: drivingHash(),
        response: {
          status: "COMPLETED",
          isOwnerDriver: false,
          documents: { driversLicense: null },
        },
      });
      databaseService.fleetOwnerAccountVerificationStageRequest.findUnique.mockResolvedValueOnce(
        replay,
      );

      await expect(
        service.saveDrivingCredentialsStage({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: { isOwnerDriver: false },
          documents: {},
        }),
      ).resolves.toEqual(replay.response);
      expect(
        databaseService.fleetOwnerAccountVerificationStageRequest.create,
      ).not.toHaveBeenCalled();
    });

    it("rejects the same driving idempotency key used with a different payload", async () => {
      databaseService.fleetOwnerAccountVerificationStageRequest.findUnique.mockResolvedValueOnce(
        stageRequest({
          stage: AccountVerificationStage.DRIVING,
          requestHash: "other-hash",
        }),
      );

      await expect(
        service.saveDrivingCredentialsStage({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: { isOwnerDriver: false },
          documents: {},
        }),
      ).rejects.toBeInstanceOf(VerificationIdempotencyKeyReusedException);
    });

    it("rejects an in-progress driving replay", async () => {
      databaseService.fleetOwnerAccountVerificationStageRequest.findUnique.mockResolvedValueOnce(
        stageRequest({
          stage: AccountVerificationStage.DRIVING,
          requestHash: drivingHash(),
          status: ProviderVerificationStatus.PROCESSING,
          processingExpiresAt: new Date("2026-12-31T00:00:00Z"),
        }),
      );

      await expect(
        service.saveDrivingCredentialsStage({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: { isOwnerDriver: false },
          documents: {},
        }),
      ).rejects.toBeInstanceOf(VerificationRequestInProgressException);
    });

    it("rejects driving when the owner's email is no longer verified, before replay", async () => {
      databaseService.user.findUnique.mockResolvedValueOnce({
        ...readyUser,
        emailVerified: false,
      });
      databaseService.fleetOwnerAccountVerificationStageRequest.findUnique.mockResolvedValueOnce(
        stageRequest({
          stage: AccountVerificationStage.DRIVING,
          requestHash: drivingHash(),
        }),
      );

      await expect(
        service.saveDrivingCredentialsStage({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: { isOwnerDriver: false },
          documents: {},
        }),
      ).rejects.toBeInstanceOf(AccountEmailNotVerifiedException);
      expect(
        databaseService.fleetOwnerAccountVerificationStageRequest.findUnique,
      ).not.toHaveBeenCalled();
    });

    it("rejects a stale draft that is no longer DRAFT during driving", async () => {
      databaseService.fleetOwnerAccountVerification.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(
        service.saveDrivingCredentialsStage({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: { isOwnerDriver: false },
          documents: {},
        }),
      ).rejects.toBeInstanceOf(AccountVerificationChangedException);
    });

    it("maps a rejected Prembly licence to not-verified without uploading or advancing", async () => {
      premblyService.verifyDriversLicense.mockRejectedValueOnce(new PremblyError("REJECTED"));

      await expect(
        service.saveDrivingCredentialsStage({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: ownerDriverDriving(),
          documents: { driversLicense: licenseFile() },
        }),
      ).rejects.toBeInstanceOf(OwnerDriverLicenseNotVerifiedException);
      expect(storageService.uploadBuffer).not.toHaveBeenCalled();
      expectDraftNotAdvanced();
    });

    it("maps an unavailable Prembly licence lookup to a provider exception", async () => {
      premblyService.verifyDriversLicense.mockRejectedValueOnce(new PremblyError("UNAVAILABLE"));

      await expect(
        service.saveDrivingCredentialsStage({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: ownerDriverDriving(),
          documents: { driversLicense: licenseFile() },
        }),
      ).rejects.toBeInstanceOf(ProviderVerificationException);
      expect(storageService.uploadBuffer).not.toHaveBeenCalled();
      expectDraftNotAdvanced();
    });

    it.each([
      ["first", { firstName: "JANE", lastName: "DOE" }],
      ["last", { firstName: "JOHN", lastName: "SMITH" }],
    ] as const)("rejects a licence %s-name mismatch", async (_label, overrides) => {
      premblyService.verifyDriversLicense.mockResolvedValueOnce({
        ...driversLicense,
        ...overrides,
      });

      await expect(
        service.saveDrivingCredentialsStage({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: ownerDriverDriving(),
          documents: { driversLicense: licenseFile() },
        }),
      ).rejects.toBeInstanceOf(OwnerDriverLicenseIdentityMismatchException);
      expectDraftNotAdvanced();
    });

    it("treats accent-normalized licence names as a match", async () => {
      databaseService.fleetOwnerAccountVerification.findFirst.mockResolvedValue(
        payoutReadyDraft({ identityFirstName: "José", identityLastName: "Doe" }),
      );
      premblyService.verifyDriversLicense.mockResolvedValueOnce({
        ...driversLicense,
        firstName: "JOSE",
        lastName: "DOE",
      });

      await expect(
        service.saveDrivingCredentialsStage({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: ownerDriverDriving(),
          documents: { driversLicense: licenseFile() },
        }),
      ).resolves.toMatchObject({ status: "COMPLETED", isOwnerDriver: true });
    });

    it("treats differently cased licence names as a match", async () => {
      premblyService.verifyDriversLicense.mockResolvedValueOnce({
        ...driversLicense,
        firstName: "John",
        lastName: "Doe",
      });

      await expect(
        service.saveDrivingCredentialsStage({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: ownerDriverDriving(),
          documents: { driversLicense: licenseFile() },
        }),
      ).resolves.toMatchObject({ status: "COMPLETED", isOwnerDriver: true });
    });

    it("rejects a licence that expired before today UTC", async () => {
      premblyService.verifyDriversLicense.mockResolvedValueOnce({
        ...driversLicense,
        expiresAt: utcStartOfDay(-1),
      });

      await expect(
        service.saveDrivingCredentialsStage({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: ownerDriverDriving(),
          documents: { driversLicense: licenseFile() },
        }),
      ).rejects.toBeInstanceOf(OwnerDriverLicenseExpiredException);
      expectDraftNotAdvanced();
    });

    it("accepts a licence that expires at the start of today UTC", async () => {
      const expiresAt = utcStartOfDay();
      premblyService.verifyDriversLicense.mockResolvedValueOnce({
        ...driversLicense,
        expiresAt,
      });

      await expect(
        service.saveDrivingCredentialsStage({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: ownerDriverDriving(),
          documents: { driversLicense: licenseFile() },
        }),
      ).resolves.toMatchObject({ status: "COMPLETED", isOwnerDriver: true });
      expect(databaseService.fleetOwnerAccountVerification.updateMany).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID, status: AccountVerificationStatus.DRAFT },
        data: expect.objectContaining({
          driversLicenseExpiresAt: expiresAt,
        }),
      });
    });

    it("fails closed when the draft is missing identity names", async () => {
      databaseService.fleetOwnerAccountVerification.findFirst.mockResolvedValue(
        payoutReadyDraft({ identityFirstName: null, identityLastName: null }),
      );

      await expect(
        service.saveDrivingCredentialsStage({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: ownerDriverDriving(),
          documents: { driversLicense: licenseFile() },
        }),
      ).rejects.toBeInstanceOf(AccountVerificationOperationFailedException);
      expect(premblyService.verifyDriversLicense).not.toHaveBeenCalled();
      expect(storageService.uploadBuffer).not.toHaveBeenCalled();
    });

    it("rejects an owner-driver without a number after documents are valid", async () => {
      databaseService.documentApproval.findUnique.mockResolvedValueOnce({
        status: DocumentStatus.APPROVED,
      });

      await expect(
        service.saveDrivingCredentialsStage({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: { isOwnerDriver: true },
          documents: {},
        }),
      ).rejects.toBeInstanceOf(OwnerDriverLicenseNotVerifiedException);
      expect(premblyService.verifyDriversLicense).not.toHaveBeenCalled();
      expectDraftNotAdvanced();
    });
  });

  describe("submitStage", () => {
    beforeEach(() => {
      databaseService.fleetOwnerAccountVerification.findFirst.mockResolvedValue(
        drivingReadyDraft(),
      );
      databaseService.fleetOwnerAccountVerification.findUnique.mockResolvedValue(
        drivingReadyDraft(),
      );
      databaseService.fleetOwnerAccountVerification.update.mockResolvedValue(
        succeededRecord({
          identityVerifiedAt: new Date("2026-01-01T00:05:00Z"),
          payoutVerifiedAt: new Date("2026-01-01T00:10:00Z"),
          drivingCompletedAt: new Date("2026-01-01T00:12:00Z"),
          submittedAt: new Date("2026-01-01T00:15:00Z"),
        }),
      );
    });

    it("approves an individual non-driver after identity, payout, and driving", async () => {
      const result = await service.submitStage(USER_ID, IDEMPOTENCY_KEY);

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
      expectNoLicenseLeak(result);
      expect(
        databaseService.fleetOwnerAccountVerificationStageRequest.updateMany,
      ).toHaveBeenCalledWith({
        where: {
          id: STAGE_REQUEST_ID,
          status: ProviderVerificationStatus.PROCESSING,
          processingExpiresAt: { gt: expect.any(Date) },
        },
        data: { updatedAt: expect.any(Date) },
      });
      expect(databaseService.fleetOwnerAccountVerification.updateMany).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID, status: AccountVerificationStatus.DRAFT },
        data: { status: AccountVerificationStatus.PROCESSING },
      });
      expect(databaseService.fleetOwnerAccountVerification.findUnique).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID },
      });
      expect(databaseService.bankDetails.updateMany).toHaveBeenCalledWith({
        where: { userId: USER_ID },
        data: { isVerified: true },
      });
      expect(databaseService.user.updateMany).toHaveBeenCalledWith({
        where: { id: USER_ID, emailVerified: true, phoneVerifiedAt: { not: null } },
        data: expect.objectContaining({
          name: "JOHN MIDDLE DOE",
          isOwnerDriver: false,
          hasOnboarded: true,
          fleetOwnerStatus: FleetOwnerStatus.APPROVED,
        }),
      });
      expect(databaseService.fleetOwnerAccountVerification.update).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID },
        data: { status: AccountVerificationStatus.SUCCEEDED, submittedAt: expect.any(Date) },
      });
    });

    it("rejects an owner-driver submit when the licence hash is missing", async () => {
      const ownerDriverDraft = drivingReadyDraft({ isOwnerDriver: true });
      databaseService.fleetOwnerAccountVerification.findFirst.mockResolvedValue(ownerDriverDraft);
      databaseService.fleetOwnerAccountVerification.findUnique.mockResolvedValue(ownerDriverDraft);
      databaseService.documentApproval.findUnique.mockResolvedValueOnce({
        status: DocumentStatus.PENDING,
      });

      await expect(service.submitStage(USER_ID, IDEMPOTENCY_KEY)).rejects.toBeInstanceOf(
        OwnerDriverLicenseNotVerifiedException,
      );
      expect(databaseService.user.updateMany).not.toHaveBeenCalled();
    });

    it("rejects an owner-driver submit when the stored licence has expired", async () => {
      const ownerDriverDraft = drivingReadyDraft({
        isOwnerDriver: true,
        ...persistedLicenseData,
        driversLicenseExpiresAt: new Date(Date.UTC(2020, 0, 1)),
      });
      databaseService.fleetOwnerAccountVerification.findFirst.mockResolvedValue(ownerDriverDraft);
      databaseService.fleetOwnerAccountVerification.findUnique.mockResolvedValue(ownerDriverDraft);
      databaseService.documentApproval.findUnique.mockResolvedValueOnce({
        status: DocumentStatus.PENDING,
      });

      await expect(service.submitStage(USER_ID, IDEMPOTENCY_KEY)).rejects.toBeInstanceOf(
        OwnerDriverLicenseExpiredException,
      );
      expect(databaseService.user.updateMany).not.toHaveBeenCalled();
    });

    it("sends an owner-driver with a hash and PENDING document to review", async () => {
      const ownerDriverDraft = drivingReadyDraft({
        isOwnerDriver: true,
        ...persistedLicenseData,
      });
      databaseService.fleetOwnerAccountVerification.findFirst.mockResolvedValue(ownerDriverDraft);
      databaseService.fleetOwnerAccountVerification.findUnique.mockResolvedValue(ownerDriverDraft);
      databaseService.documentApproval.findUnique.mockResolvedValueOnce({
        status: DocumentStatus.PENDING,
      });
      databaseService.fleetOwnerAccountVerification.update.mockResolvedValue(
        succeededRecord({
          status: AccountVerificationStatus.REVIEW_REQUIRED,
          isOwnerDriver: true,
          ...persistedLicenseData,
          submittedAt: new Date("2026-01-01T00:15:00Z"),
        }),
      );

      const result = await service.submitStage(USER_ID, IDEMPOTENCY_KEY);

      expect(result).toMatchObject({ status: AccountVerificationStatus.REVIEW_REQUIRED });
      expectNoLicenseLeak(result);
      expect(databaseService.user.updateMany).toHaveBeenCalledWith({
        where: { id: USER_ID, emailVerified: true, phoneVerifiedAt: { not: null } },
        data: expect.objectContaining({ fleetOwnerStatus: FleetOwnerStatus.PROCESSING }),
      });
    });

    it("submits a business draft without a separate driving stage", async () => {
      const businessDraft = payoutReadyDraft({
        accountType: FleetOwnerAccountType.BUSINESS,
        businessName: "HYRE MOBILITY LTD",
        isOwnerDriver: false,
        drivingCompletedAt: new Date("2026-01-01T00:05:00Z"),
      });
      databaseService.fleetOwnerAccountVerification.findFirst.mockResolvedValue(businessDraft);
      databaseService.fleetOwnerAccountVerification.findUnique.mockResolvedValue(businessDraft);
      databaseService.fleetOwnerAccountVerification.update.mockResolvedValueOnce(
        succeededRecord({
          accountType: FleetOwnerAccountType.BUSINESS,
          businessName: "HYRE MOBILITY LTD",
          isOwnerDriver: false,
        }),
      );

      await expect(service.submitStage(USER_ID, IDEMPOTENCY_KEY)).resolves.toMatchObject({
        status: AccountVerificationStatus.SUCCEEDED,
        accountType: FleetOwnerAccountType.BUSINESS,
        businessName: "HYRE MOBILITY LTD",
      });
    });

    it.each([
      ["identity review", { identityRequiresReview: true }],
      ["payout review", { bankNameMatch: NameMatchStatus.REVIEW_REQUIRED }],
    ])("sends a %s draft to REVIEW_REQUIRED on submit", async (_label, overrides) => {
      const reviewDraft = drivingReadyDraft(overrides);
      databaseService.fleetOwnerAccountVerification.findFirst.mockResolvedValue(reviewDraft);
      databaseService.fleetOwnerAccountVerification.findUnique.mockResolvedValue(reviewDraft);
      databaseService.fleetOwnerAccountVerification.update.mockResolvedValue(
        succeededRecord({ status: AccountVerificationStatus.REVIEW_REQUIRED }),
      );

      await expect(service.submitStage(USER_ID, IDEMPOTENCY_KEY)).resolves.toMatchObject({
        status: AccountVerificationStatus.REVIEW_REQUIRED,
      });
      expect(databaseService.user.updateMany).toHaveBeenCalledWith({
        where: { id: USER_ID, emailVerified: true, phoneVerifiedAt: { not: null } },
        data: expect.objectContaining({ fleetOwnerStatus: FleetOwnerStatus.PROCESSING }),
      });
    });

    it("rejects submit before identity has created a draft", async () => {
      databaseService.fleetOwnerAccountVerification.findFirst.mockResolvedValue(null);

      await expect(service.submitStage(USER_ID, IDEMPOTENCY_KEY)).rejects.toBeInstanceOf(
        AccountVerificationNotFoundException,
      );
    });

    it("rejects submit before payout is complete", async () => {
      databaseService.fleetOwnerAccountVerification.findFirst.mockResolvedValue(draftRecord());

      await expect(service.submitStage(USER_ID, IDEMPOTENCY_KEY)).rejects.toBeInstanceOf(
        AccountVerificationStepIncompleteException,
      );
    });

    it("rejects submit before driving is complete", async () => {
      databaseService.fleetOwnerAccountVerification.findFirst.mockResolvedValue(payoutReadyDraft());

      await expect(service.submitStage(USER_ID, IDEMPOTENCY_KEY)).rejects.toBeInstanceOf(
        AccountVerificationStepIncompleteException,
      );
    });

    it("replays a succeeded submission with the same idempotency key", async () => {
      const replay = stageRequest({
        stage: AccountVerificationStage.SUBMISSION,
        requestHash: submissionHash(),
        response: { id: VERIFICATION_ID, status: AccountVerificationStatus.SUCCEEDED },
      });
      databaseService.fleetOwnerAccountVerificationStageRequest.findUnique.mockResolvedValueOnce(
        replay,
      );

      await expect(service.submitStage(USER_ID, IDEMPOTENCY_KEY)).resolves.toEqual(replay.response);
      expect(
        databaseService.fleetOwnerAccountVerificationStageRequest.create,
      ).not.toHaveBeenCalled();
      expect(databaseService.user.updateMany).not.toHaveBeenCalled();
    });

    it("replays a failed submission that required an owner-driver licence", async () => {
      databaseService.fleetOwnerAccountVerificationStageRequest.findUnique.mockResolvedValueOnce(
        stageRequest({
          stage: AccountVerificationStage.SUBMISSION,
          requestHash: submissionHash(),
          status: ProviderVerificationStatus.FAILED,
          failureReason: AccountVerificationErrorCode.DRIVER_LICENSE_REQUIRED,
        }),
      );

      await expect(service.submitStage(USER_ID, IDEMPOTENCY_KEY)).rejects.toBeInstanceOf(
        OwnerDriverLicenseRequiredException,
      );
      expect(databaseService.user.updateMany).not.toHaveBeenCalled();
    });

    it.each([
      [
        AccountVerificationErrorCode.DRIVER_LICENSE_NOT_VERIFIED,
        OwnerDriverLicenseNotVerifiedException,
      ],
      [AccountVerificationErrorCode.DRIVER_LICENSE_EXPIRED, OwnerDriverLicenseExpiredException],
      [
        AccountVerificationErrorCode.DRIVER_LICENSE_IDENTITY_MISMATCH,
        OwnerDriverLicenseIdentityMismatchException,
      ],
    ] as const)("replays a failed submission with %s", async (failureReason, Exception) => {
      databaseService.fleetOwnerAccountVerificationStageRequest.findUnique.mockResolvedValueOnce(
        stageRequest({
          stage: AccountVerificationStage.SUBMISSION,
          requestHash: submissionHash(),
          status: ProviderVerificationStatus.FAILED,
          failureReason,
        }),
      );

      await expect(service.submitStage(USER_ID, IDEMPOTENCY_KEY)).rejects.toBeInstanceOf(Exception);
      expect(databaseService.user.updateMany).not.toHaveBeenCalled();
    });

    it("rejects an in-progress submission replay", async () => {
      databaseService.fleetOwnerAccountVerificationStageRequest.findUnique.mockResolvedValueOnce(
        stageRequest({
          stage: AccountVerificationStage.SUBMISSION,
          requestHash: submissionHash(),
          status: ProviderVerificationStatus.PROCESSING,
          processingExpiresAt: new Date("2026-12-31T00:00:00Z"),
        }),
      );

      await expect(service.submitStage(USER_ID, IDEMPOTENCY_KEY)).rejects.toBeInstanceOf(
        VerificationRequestInProgressException,
      );
    });

    it("rejects submit when the owner's phone is no longer verified, before replay", async () => {
      databaseService.user.findUnique.mockResolvedValueOnce({
        ...readyUser,
        phoneVerifiedAt: null,
      });
      databaseService.fleetOwnerAccountVerificationStageRequest.findUnique.mockResolvedValueOnce(
        stageRequest({
          stage: AccountVerificationStage.SUBMISSION,
          requestHash: submissionHash(),
        }),
      );

      await expect(service.submitStage(USER_ID, IDEMPOTENCY_KEY)).rejects.toBeInstanceOf(
        AccountPhoneNotVerifiedException,
      );
      expect(
        databaseService.fleetOwnerAccountVerificationStageRequest.findUnique,
      ).not.toHaveBeenCalled();
    });

    it("rejects a stale draft that can no longer move from DRAFT to PROCESSING", async () => {
      databaseService.fleetOwnerAccountVerification.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(service.submitStage(USER_ID, IDEMPOTENCY_KEY)).rejects.toBeInstanceOf(
        AccountVerificationChangedException,
      );
      expect(databaseService.user.updateMany).not.toHaveBeenCalled();
    });

    it("rejects submit when email or phone is revoked during the guarded user update", async () => {
      databaseService.user.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(service.submitStage(USER_ID, IDEMPOTENCY_KEY)).rejects.toBeInstanceOf(
        AccountVerificationChangedException,
      );
      expect(databaseService.fleetOwnerAccountVerification.updateMany).toHaveBeenCalledWith({
        where: { id: VERIFICATION_ID, status: AccountVerificationStatus.DRAFT },
        data: { status: AccountVerificationStatus.PROCESSING },
      });
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
        steps: { contact: "PENDING" },
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
        identity: { status: AccountVerificationStatus.SUCCEEDED },
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
        accountVerifications: [succeededRecord({ isOwnerDriver: true })],
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
        steps: { contact: "PENDING" },
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

    const readyStatusUser = (overrides: Record<string, unknown> = {}) => ({
      emailVerified: true,
      phoneNumber: PHONE_NUMBER,
      phoneVerifiedAt: new Date(),
      hasOnboarded: false,
      isOwnerDriver: false,
      fleetOwnerStatus: FleetOwnerStatus.PROCESSING,
      bankDetails: null,
      documents: [],
      accountVerifications: [],
      ...overrides,
    });

    it.each([
      { emailVerified: false, phoneVerified: false, contact: "PENDING" },
      { emailVerified: true, phoneVerified: false, contact: "PENDING" },
      { emailVerified: false, phoneVerified: true, contact: "PENDING" },
      { emailVerified: true, phoneVerified: true, contact: "VERIFIED" },
    ])(
      "marks steps.contact $contact when emailVerified=$emailVerified and phoneVerified=$phoneVerified",
      async ({ emailVerified, phoneVerified, contact }) => {
        databaseService.user.findUnique.mockResolvedValueOnce(
          readyStatusUser({
            emailVerified,
            phoneVerifiedAt: phoneVerified ? new Date("2026-01-01T00:00:00Z") : null,
          }),
        );

        await expect(service.getStatus(USER_ID)).resolves.toMatchObject({
          steps: { contact },
        });
      },
    );

    it("asks for identity before any staged verification exists", async () => {
      databaseService.user.findUnique.mockResolvedValueOnce(readyStatusUser());

      await expect(service.getStatus(USER_ID)).resolves.toMatchObject({
        status: "ACTION_REQUIRED",
        requiredActions: ["VERIFY_ACCOUNT"],
        nextAction: "VERIFY_IDENTITY",
        steps: {
          contact: "VERIFIED",
          identity: "PENDING",
          payout: "PENDING",
          driving: "PENDING",
          submission: "PENDING",
        },
      });
    });

    it("advances nextAction to payout after a successful individual identity stage", async () => {
      databaseService.user.findUnique.mockResolvedValueOnce(
        readyStatusUser({ accountVerifications: [draftRecord()] }),
      );

      await expect(service.getStatus(USER_ID)).resolves.toMatchObject({
        status: "ACTION_REQUIRED",
        requiredActions: ["VERIFY_ACCOUNT"],
        nextAction: "VERIFY_PAYOUT",
        identity: {
          status: AccountVerificationStatus.SUCCEEDED,
          legalName: "JOHN MIDDLE DOE",
        },
        steps: {
          contact: "VERIFIED",
          identity: "VERIFIED",
          payout: "PENDING",
          driving: "PENDING",
          submission: "PENDING",
        },
      });
    });

    it("skips driving and still requires payout after a business identity stage", async () => {
      databaseService.user.findUnique.mockResolvedValueOnce(
        readyStatusUser({
          accountVerifications: [
            draftRecord({
              accountType: FleetOwnerAccountType.BUSINESS,
              businessName: "HYRE MOBILITY LTD",
              isOwnerDriver: false,
              drivingCompletedAt: new Date("2026-01-01T00:05:00Z"),
            }),
          ],
        }),
      );

      await expect(service.getStatus(USER_ID)).resolves.toMatchObject({
        nextAction: "VERIFY_PAYOUT",
        steps: {
          identity: "VERIFIED",
          payout: "PENDING",
          driving: "SKIPPED",
          submission: "PENDING",
        },
      });
    });

    it("asks for driving credentials after an individual payout stage", async () => {
      databaseService.user.findUnique.mockResolvedValueOnce(
        readyStatusUser({
          bankDetails: {
            bankName: "GTBank",
            accountName: "JOHN DOE",
            accountNumber: "0123456789",
            isVerified: false,
          },
          accountVerifications: [payoutReadyDraft()],
        }),
      );

      await expect(service.getStatus(USER_ID)).resolves.toMatchObject({
        nextAction: "PROVIDE_DRIVING_CREDENTIALS",
        steps: {
          identity: "VERIFIED",
          payout: "VERIFIED",
          driving: "PENDING",
          submission: "PENDING",
        },
      });
    });

    it("asks to submit after driving credentials are stored", async () => {
      databaseService.user.findUnique.mockResolvedValueOnce(
        readyStatusUser({
          bankDetails: {
            bankName: "GTBank",
            accountName: "JOHN DOE",
            accountNumber: "0123456789",
            isVerified: false,
          },
          accountVerifications: [drivingReadyDraft()],
        }),
      );

      await expect(service.getStatus(USER_ID)).resolves.toMatchObject({
        nextAction: "SUBMIT_ACCOUNT",
        steps: {
          identity: "VERIFIED",
          payout: "VERIFIED",
          driving: "COMPLETED",
          submission: "PENDING",
        },
      });
    });

    it("sends an owner-driver without a licence hash back to driving", async () => {
      databaseService.user.findUnique.mockResolvedValueOnce(
        readyStatusUser({
          bankDetails: {
            bankName: "GTBank",
            accountName: "JOHN DOE",
            accountNumber: "0123456789",
            isVerified: false,
          },
          accountVerifications: [drivingReadyDraft({ isOwnerDriver: true })],
        }),
      );

      await expect(service.getStatus(USER_ID)).resolves.toMatchObject({
        nextAction: "PROVIDE_DRIVING_CREDENTIALS",
        steps: {
          identity: "VERIFIED",
          payout: "VERIFIED",
          driving: "PENDING",
          submission: "PENDING",
        },
      });
    });

    it("asks an owner-driver with a stored licence hash to submit", async () => {
      databaseService.user.findUnique.mockResolvedValueOnce(
        readyStatusUser({
          bankDetails: {
            bankName: "GTBank",
            accountName: "JOHN DOE",
            accountNumber: "0123456789",
            isVerified: false,
          },
          accountVerifications: [
            drivingReadyDraft({ isOwnerDriver: true, ...persistedLicenseData }),
          ],
        }),
      );

      await expect(service.getStatus(USER_ID)).resolves.toMatchObject({
        nextAction: "SUBMIT_ACCOUNT",
        steps: { driving: "COMPLETED", submission: "PENDING" },
      });
    });

    it("surfaces REVIEW_REQUIRED identity and payout while advancing through later stages", async () => {
      databaseService.user.findUnique.mockResolvedValueOnce(
        readyStatusUser({
          bankDetails: {
            bankName: "GTBank",
            accountName: "JOHN SMITH",
            accountNumber: "0123456789",
            isVerified: false,
          },
          accountVerifications: [
            drivingReadyDraft({
              identityRequiresReview: true,
              accountName: "JOHN SMITH",
              bankNameMatch: NameMatchStatus.REVIEW_REQUIRED,
            }),
          ],
        }),
      );

      await expect(service.getStatus(USER_ID)).resolves.toMatchObject({
        nextAction: "SUBMIT_ACCOUNT",
        identity: { status: AccountVerificationStatus.REVIEW_REQUIRED },
        steps: {
          identity: "REVIEW_REQUIRED",
          payout: "REVIEW_REQUIRED",
          driving: "COMPLETED",
          submission: "PENDING",
        },
      });
    });

    it("waits for review after a review-required submission", async () => {
      databaseService.user.findUnique.mockResolvedValueOnce(
        readyStatusUser({
          hasOnboarded: true,
          bankDetails: {
            bankName: "GTBank",
            accountName: "JOHN DOE",
            accountNumber: "0123456789",
            isVerified: false,
          },
          accountVerifications: [
            drivingReadyDraft({
              status: AccountVerificationStatus.REVIEW_REQUIRED,
              identityRequiresReview: true,
              submittedAt: new Date("2026-01-01T00:15:00Z"),
            }),
          ],
        }),
      );

      await expect(service.getStatus(USER_ID)).resolves.toMatchObject({
        status: "UNDER_REVIEW",
        requiredActions: [],
        nextAction: "WAIT_FOR_REVIEW",
        identity: { status: AccountVerificationStatus.REVIEW_REQUIRED },
        steps: {
          identity: "REVIEW_REQUIRED",
          payout: "VERIFIED",
          driving: "COMPLETED",
          submission: "REVIEW_REQUIRED",
        },
      });
    });

    it("returns COMPLETE after a succeeded staged submission", async () => {
      databaseService.user.findUnique.mockResolvedValueOnce(
        readyStatusUser({
          hasOnboarded: true,
          fleetOwnerStatus: FleetOwnerStatus.APPROVED,
          bankDetails: {
            bankName: "GTBank",
            accountName: "JOHN DOE",
            accountNumber: "0123456789",
            isVerified: true,
          },
          accountVerifications: [
            succeededRecord({
              identityVerifiedAt: new Date("2026-01-01T00:05:00Z"),
              payoutVerifiedAt: new Date("2026-01-01T00:10:00Z"),
              drivingCompletedAt: new Date("2026-01-01T00:12:00Z"),
              submittedAt: new Date("2026-01-01T00:15:00Z"),
            }),
          ],
        }),
      );

      await expect(service.getStatus(USER_ID)).resolves.toMatchObject({
        status: "VERIFIED",
        requiredActions: [],
        nextAction: "COMPLETE",
        steps: {
          identity: "VERIFIED",
          payout: "VERIFIED",
          driving: "COMPLETED",
          submission: "VERIFIED",
        },
      });
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
        service.create({
          userId: USER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          input: individualInput(),
          documents: {},
        }),
      ).rejects.toBeInstanceOf(AccountManualReviewRejectedException);
    });
  });

  describe("replaceRejectedDriversLicense", () => {
    const rejectedLicense = {
      id: "doc-1",
      documentType: DocumentType.DRIVERS_LICENSE,
      status: DocumentStatus.REJECTED,
      documentUrl: "old-license-key",
      notes: "Unreadable photo",
      approvedAt: new Date("2026-09-01T00:00:00Z"),
      approvedById: REVIEWER_ID,
    };
    const updatedLicense = {
      ...rejectedLicense,
      status: DocumentStatus.PENDING,
      documentUrl: `https://cdn.test/${USER_ID}/${VERIFICATION_ID}/documents/drivers_license-license.pdf`,
      notes: null,
      approvedAt: null,
      approvedById: null,
    };

    const replaceRejectedDriversLicense = (userId: string, file: UploadedAccountDocument) =>
      (
        service as AccountVerificationService & {
          replaceRejectedDriversLicense: (
            userId: string,
            file: UploadedAccountDocument,
          ) => Promise<typeof updatedLicense>;
        }
      ).replaceRejectedDriversLicense(userId, file);

    const mockReplacementTransaction = () => {
      databaseService.fleetOwnerAccountVerification.findFirst.mockResolvedValue({
        id: VERIFICATION_ID,
        status: AccountVerificationStatus.REVIEW_REQUIRED,
      });
      databaseService.documentApproval.update.mockResolvedValue(updatedLicense);
      databaseService.$transaction.mockImplementationOnce(async (callback) =>
        callback({
          documentApproval: databaseService.documentApproval,
          fleetOwnerAccountVerification: databaseService.fleetOwnerAccountVerification,
        }),
      );
    };

    it("replaces an owned rejected licence during REVIEW_REQUIRED without re-running identity or bank checks", async () => {
      const licence = licenseFile();
      databaseService.documentApproval.findUnique.mockResolvedValueOnce(rejectedLicense);
      mockReplacementTransaction();

      await expect(replaceRejectedDriversLicense(USER_ID, licence)).resolves.toMatchObject({
        id: "doc-1",
        documentType: DocumentType.DRIVERS_LICENSE,
        status: DocumentStatus.PENDING,
        documentUrl: updatedLicense.documentUrl,
      });

      expect(premblyService.verifyNin).not.toHaveBeenCalled();
      expect(premblyService.verifyCac).not.toHaveBeenCalled();
      expect(flutterwaveService.resolveBankAccount).not.toHaveBeenCalled();
      expect(storageService.uploadBuffer).toHaveBeenCalledWith(
        licence.buffer,
        expect.stringMatching(
          new RegExp(
            `^fleet-owners/${USER_ID}/account-verifications/${VERIFICATION_ID}/documents/[0-9a-f-]{36}\\.pdf$`,
          ),
        ),
        "application/pdf",
      );
      expect(databaseService.documentApproval.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            documentType_userId: { documentType: DocumentType.DRIVERS_LICENSE, userId: USER_ID },
          },
        }),
      );
      expect(databaseService.fleetOwnerAccountVerification.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: USER_ID,
            status: AccountVerificationStatus.REVIEW_REQUIRED,
          }),
        }),
      );
      expect(databaseService.$transaction).toHaveBeenCalled();
      const stored = (await storageService.uploadBuffer.mock.results[0]?.value) as {
        url: string;
      };
      expect(databaseService.documentApproval.update).toHaveBeenCalledWith({
        where: expect.objectContaining({ status: DocumentStatus.REJECTED }),
        data: expect.objectContaining({
          documentUrl: stored.url,
          status: DocumentStatus.PENDING,
          notes: null,
          approvedAt: null,
          approvedById: null,
        }),
      });
      expect(storageService.deleteObjectByKey).toHaveBeenCalledWith("old-license-key");
    });

    it.each([
      ["missing", null],
      [
        "pending",
        { ...rejectedLicense, status: DocumentStatus.PENDING, notes: null, approvedAt: null },
      ],
      ["approved", { ...rejectedLicense, status: DocumentStatus.APPROVED }],
    ])("rejects replacement when the owned driver's licence is %s", async (_label, existing) => {
      databaseService.documentApproval.findUnique.mockResolvedValueOnce(existing);
      databaseService.fleetOwnerAccountVerification.findFirst.mockResolvedValue({
        id: VERIFICATION_ID,
        status: AccountVerificationStatus.REVIEW_REQUIRED,
      });

      await expect(replaceRejectedDriversLicense(USER_ID, licenseFile())).rejects.toBeInstanceOf(
        AccountDocumentInvalidException,
      );
      expect(storageService.uploadBuffer).not.toHaveBeenCalled();
      expect(databaseService.documentApproval.update).not.toHaveBeenCalled();
      expect(premblyService.verifyNin).not.toHaveBeenCalled();
    });

    it("rejects replacement when there is no owned REVIEW_REQUIRED account verification", async () => {
      databaseService.documentApproval.findUnique.mockResolvedValueOnce(rejectedLicense);
      databaseService.fleetOwnerAccountVerification.findFirst.mockResolvedValueOnce(null);

      await expect(replaceRejectedDriversLicense(USER_ID, licenseFile())).rejects.toBeInstanceOf(
        AccountVerificationReviewNotPendingException,
      );
      expect(storageService.uploadBuffer).not.toHaveBeenCalled();
      expect(databaseService.documentApproval.update).not.toHaveBeenCalled();
      expect(premblyService.verifyNin).not.toHaveBeenCalled();
    });

    it("deletes the newly uploaded object when the document update fails", async () => {
      const licence = licenseFile();
      databaseService.documentApproval.findUnique.mockResolvedValueOnce(rejectedLicense);
      databaseService.fleetOwnerAccountVerification.findFirst.mockResolvedValue({
        id: VERIFICATION_ID,
        status: AccountVerificationStatus.REVIEW_REQUIRED,
      });
      databaseService.documentApproval.update.mockRejectedValueOnce(new Error("db down"));
      databaseService.$transaction.mockRejectedValueOnce(new Error("db write failed"));

      await expect(replaceRejectedDriversLicense(USER_ID, licence)).rejects.toBeInstanceOf(
        AccountVerificationOperationFailedException,
      );
      expect(storageService.uploadBuffer).toHaveBeenCalled();
      const requestedKey = storageService.uploadBuffer.mock.calls[0]?.[1] as string;
      const stored = (await storageService.uploadBuffer.mock.results[0]?.value) as {
        key: string;
      };
      expect(storageService.deleteObjectByKey).toHaveBeenCalledWith(stored.key);
      expect(storageService.deleteObjectByKey).not.toHaveBeenCalledWith(requestedKey);
    });

    it("still returns the updated document when old object cleanup fails", async () => {
      databaseService.documentApproval.findUnique.mockResolvedValueOnce(rejectedLicense);
      mockReplacementTransaction();
      storageService.deleteObjectByKey.mockRejectedValueOnce(new Error("s3 down"));

      await expect(replaceRejectedDriversLicense(USER_ID, licenseFile())).resolves.toMatchObject({
        status: DocumentStatus.PENDING,
        id: "doc-1",
      });
    });
  });
});
