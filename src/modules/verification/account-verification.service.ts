import { createHash, createHmac, randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  AccountVerificationStage,
  AccountVerificationStatus,
  DocumentStatus,
  DocumentType,
  FleetOwnerAccountType,
  type FleetOwnerAccountVerification,
  FleetOwnerStatus,
  NameMatchStatus,
  Prisma,
  ProviderVerificationStatus,
} from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import type { EnvConfig } from "../../config/env.config";
import { DatabaseService, isUniqueConstraintError } from "../database/database.service";
import { FlutterwaveError } from "../flutterwave/flutterwave.interface";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";
import type { PremblyCacResult, PremblyNinResult } from "../prembly/prembly.interface";
import { PremblyError, PremblyService } from "../prembly/prembly.service";
import { StorageService } from "../storage/storage.service";
import type { AccountDocuments } from "./account-documents.pipe";
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
  AccountVerificationException,
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
  OwnerDriverLicenseNotApprovedException,
  OwnerDriverLicenseRequiredException,
} from "./account-verification.error";
import {
  ProviderVerificationException,
  VerificationErrorCode,
  VerificationIdempotencyKeyReusedException,
  VerificationRequestInProgressException,
} from "./verification.error";

const CORPORATE_SUFFIXES = new Set([
  "CO",
  "COMPANY",
  "INC",
  "INCORPORATED",
  "LIMITED",
  "LLC",
  "LTD",
  "PLC",
]);
const PERSON_TITLES = new Set(["DR", "MISS", "MR", "MRS", "MS"]);
const PROCESSING_TTL_MS = 15 * 60 * 1000;

type VerifiedAccountIdentity = {
  identity: PremblyNinResult;
  legalName: string;
  business?: PremblyCacResult;
  businessNameMatch?: NameMatchStatus;
  representativeNameMatch?: NameMatchStatus;
};

type StageResponse = Prisma.InputJsonObject;

type OnboardingProgress = {
  identityComplete: boolean;
  payoutComplete: boolean;
  drivingComplete: boolean;
  submissionComplete: boolean;
};

function onboardingProgress(
  verification: FleetOwnerAccountVerification | null,
): OnboardingProgress {
  return {
    identityComplete: Boolean(verification?.identityVerifiedAt ?? verification?.legalName),
    payoutComplete: Boolean(verification?.payoutVerifiedAt ?? verification?.accountName),
    drivingComplete:
      verification?.accountType === FleetOwnerAccountType.BUSINESS ||
      Boolean(verification?.drivingCompletedAt ?? verification?.submittedAt),
    submissionComplete:
      verification?.status === AccountVerificationStatus.SUCCEEDED ||
      verification?.status === AccountVerificationStatus.REVIEW_REQUIRED,
  };
}

function nextOnboardingAction(
  emailVerified: boolean,
  phoneVerified: boolean,
  progress: OnboardingProgress,
  verificationStatus?: AccountVerificationStatus,
) {
  if (!emailVerified) return "VERIFY_EMAIL";
  if (!phoneVerified) return "VERIFY_PHONE";
  if (!progress.identityComplete) return "VERIFY_IDENTITY";
  if (!progress.payoutComplete) return "VERIFY_PAYOUT";
  if (!progress.drivingComplete) return "PROVIDE_DRIVING_CREDENTIALS";
  if (!progress.submissionComplete) return "SUBMIT_ACCOUNT";
  return verificationStatus === AccountVerificationStatus.REVIEW_REQUIRED
    ? "WAIT_FOR_REVIEW"
    : "COMPLETE";
}

function reviewedStepStatus(complete: boolean, requiresReview: boolean) {
  if (!complete) return "PENDING";
  return requiresReview ? "REVIEW_REQUIRED" : "VERIFIED";
}

function drivingStepStatus(verification: FleetOwnerAccountVerification | null, complete: boolean) {
  if (verification?.accountType === FleetOwnerAccountType.BUSINESS) return "SKIPPED";
  return complete ? "COMPLETED" : "PENDING";
}

function submissionStepStatus(verification: FleetOwnerAccountVerification | null) {
  if (verification?.status === AccountVerificationStatus.SUCCEEDED) return "VERIFIED";
  if (verification?.status === AccountVerificationStatus.REVIEW_REQUIRED) {
    return "REVIEW_REQUIRED";
  }
  return "PENDING";
}

@Injectable()
export class AccountVerificationService {
  private readonly hashKey: string;

  constructor(
    configService: ConfigService<EnvConfig, true>,
    private readonly databaseService: DatabaseService,
    private readonly premblyService: PremblyService,
    private readonly flutterwaveService: FlutterwaveService,
    private readonly storageService: StorageService,
    private readonly logger: PinoLogger,
  ) {
    this.hashKey = configService.get("HMAC_KEY", { infer: true });
    this.logger.setContext(AccountVerificationService.name);
  }

  async create(
    userId: string,
    idempotencyKey: string,
    input: CreateAccountVerificationDto,
    documents: AccountDocuments,
  ) {
    const user = await this.assertUserCanVerify(userId);
    const driverLicenseApproved = await this.assertDocumentsValid(
      userId,
      input.isOwnerDriver,
      documents,
    );

    const requestHash = this.hashRequest(input, documents);
    const claim = await this.claimVerification(
      userId,
      idempotencyKey,
      requestHash,
      input,
      user.fleetOwnerStatus === FleetOwnerStatus.APPROVED,
    );
    if (claim.kind === "REPLAYED") return claim.response;
    const verification = claim.verification;

    const uploaded: Array<{ type: DocumentType; key: string; url: string }> = [];
    try {
      const { identity, legalName, business, businessNameMatch, representativeNameMatch } =
        await this.verifyIdentity(input);

      const resolvedAccount = await this.flutterwaveService.resolveBankAccount(
        input.bankCode,
        input.accountNumber,
      );
      const bankNameMatch = this.matchBankAccountName(
        input.accountType,
        identity,
        business,
        resolvedAccount.accountName,
      );
      if (bankNameMatch === NameMatchStatus.MISMATCHED) {
        throw new BankAccountNameMismatchException();
      }

      for (const [type, file] of [
        [DocumentType.DRIVERS_LICENSE, documents.driversLicense],
        [DocumentType.LASDRI, documents.lasdri],
      ] as const) {
        if (file) uploaded.push(await this.uploadDocument(userId, verification.id, type, file));
      }

      const verifiedAt = new Date();
      const needsReview =
        bankNameMatch === NameMatchStatus.REVIEW_REQUIRED ||
        businessNameMatch === NameMatchStatus.REVIEW_REQUIRED ||
        representativeNameMatch === NameMatchStatus.REVIEW_REQUIRED ||
        business?.status === null ||
        !driverLicenseApproved;
      const status = needsReview
        ? AccountVerificationStatus.REVIEW_REQUIRED
        : AccountVerificationStatus.SUCCEEDED;

      const previousDocuments = await this.databaseService.documentApproval.findMany({
        where: {
          userId,
          documentType: { in: uploaded.map(({ type }) => type) },
        },
        select: { documentType: true, documentUrl: true },
      });
      const completed = await this.databaseService.$transaction(async (tx) => {
        const lease = await tx.fleetOwnerAccountVerification.updateMany({
          where: {
            id: verification.id,
            status: AccountVerificationStatus.PROCESSING,
            processingExpiresAt: { gt: verifiedAt },
          },
          data: { updatedAt: verifiedAt },
        });
        if (lease.count === 0) throw new AccountVerificationChangedException();

        await tx.bankDetails.upsert({
          where: { userId },
          create: {
            userId,
            bankName: input.bankName,
            bankCode: input.bankCode,
            accountNumber: resolvedAccount.accountNumber,
            accountName: resolvedAccount.accountName,
            isVerified: status === AccountVerificationStatus.SUCCEEDED,
            lastVerifiedAt: verifiedAt,
          },
          update: {
            bankName: input.bankName,
            bankCode: input.bankCode,
            accountNumber: resolvedAccount.accountNumber,
            accountName: resolvedAccount.accountName,
            isVerified: status === AccountVerificationStatus.SUCCEEDED,
            lastVerifiedAt: verifiedAt,
            verificationResponse: null,
          },
        });

        for (const document of uploaded) {
          await tx.documentApproval.upsert({
            where: {
              documentType_userId: { documentType: document.type, userId },
            },
            create: {
              userId,
              documentType: document.type,
              documentUrl: document.url,
            },
            update: {
              documentUrl: document.url,
              status: DocumentStatus.PENDING,
              notes: null,
              approvedAt: null,
              approvedById: null,
            },
          });
        }

        await tx.user.update({
          where: { id: userId },
          data: {
            name: legalName,
            isOwnerDriver: input.isOwnerDriver,
            hasOnboarded: true,
            fleetOwnerStatus:
              status === AccountVerificationStatus.SUCCEEDED
                ? FleetOwnerStatus.APPROVED
                : FleetOwnerStatus.PROCESSING,
          },
        });

        return tx.fleetOwnerAccountVerification.update({
          where: { id: verification.id },
          data: {
            status,
            identityFirstName: identity.firstName,
            identityLastName: identity.lastName,
            legalName,
            businessName: business?.businessName,
            businessNameMatch,
            registrationNumber: business?.registrationNumber,
            registrationType: business?.registrationType,
            identityProviderRef: identity.reference,
            businessProviderRef: business?.reference,
            identityRequiresReview:
              businessNameMatch === NameMatchStatus.REVIEW_REQUIRED ||
              representativeNameMatch === NameMatchStatus.REVIEW_REQUIRED ||
              business?.status === null,
            identityVerifiedAt: verifiedAt,
            bankName: input.bankName,
            bankCode: input.bankCode,
            accountNumberLast4: resolvedAccount.accountNumber.slice(-4),
            accountName: resolvedAccount.accountName,
            bankNameMatch,
            payoutVerifiedAt: verifiedAt,
            representativeNameMatch,
            drivingCompletedAt: verifiedAt,
            submittedAt: verifiedAt,
          },
        });
      });

      await this.deleteReplacedDocuments(previousDocuments, uploaded);
      return this.toResponse(completed);
    } catch (error) {
      await this.deleteUploaded(uploaded);
      throw await this.fail(verification.id, error);
    }
  }

  async verifyIdentityStage(
    userId: string,
    idempotencyKey: string,
    input: AccountIdentityVerificationDto,
  ) {
    const user = await this.assertUserCanVerify(userId);
    const requestHash = this.hashValue({ stage: "IDENTITY", input });
    const claim = await this.claimIdentityStage(
      userId,
      idempotencyKey,
      requestHash,
      input,
      user.fleetOwnerStatus === FleetOwnerStatus.APPROVED,
    );
    if (claim.kind === "REPLAYED") return claim.response;

    try {
      const verified = await this.verifyIdentity(input);
      const verifiedAt = new Date();
      const identityRequiresReview =
        verified.businessNameMatch === NameMatchStatus.REVIEW_REQUIRED ||
        verified.representativeNameMatch === NameMatchStatus.REVIEW_REQUIRED ||
        verified.business?.status === null;
      const completed = await this.databaseService.$transaction(async (tx) => {
        const lease = await tx.fleetOwnerAccountVerification.updateMany({
          where: {
            id: claim.verification.id,
            status: AccountVerificationStatus.PROCESSING,
            processingExpiresAt: { gt: verifiedAt },
          },
          data: { updatedAt: verifiedAt },
        });
        if (lease.count === 0) throw new AccountVerificationChangedException();

        await tx.bankDetails.updateMany({
          where: { userId },
          data: { isVerified: false },
        });
        return tx.fleetOwnerAccountVerification.update({
          where: { id: claim.verification.id },
          data: {
            status: AccountVerificationStatus.DRAFT,
            identityFirstName: verified.identity.firstName,
            identityLastName: verified.identity.lastName,
            legalName: verified.legalName,
            businessName: verified.business?.businessName,
            businessNameMatch: verified.businessNameMatch,
            registrationNumber: verified.business?.registrationNumber,
            registrationType: verified.business?.registrationType,
            identityProviderRef: verified.identity.reference,
            businessProviderRef: verified.business?.reference,
            representativeNameMatch: verified.representativeNameMatch,
            identityRequiresReview,
            identityVerifiedAt: verifiedAt,
            isOwnerDriver: input.accountType === FleetOwnerAccountType.BUSINESS ? false : undefined,
            drivingCompletedAt:
              input.accountType === FleetOwnerAccountType.BUSINESS ? verifiedAt : undefined,
            processingExpiresAt: verifiedAt,
          },
        });
      });
      return this.toIdentityStageResponse(completed);
    } catch (error) {
      throw await this.fail(claim.verification.id, error);
    }
  }

  async verifyPayoutStage(userId: string, idempotencyKey: string, input: PayoutVerificationDto) {
    await this.assertUserCanVerify(userId);
    const requestHash = this.hashValue({ stage: AccountVerificationStage.PAYOUT, input });
    const replay = await this.findStageReplay(
      userId,
      idempotencyKey,
      AccountVerificationStage.PAYOUT,
      requestHash,
    );
    if (replay) return replay;

    const verification = await this.findDraft(userId);
    if (!verification.identityVerifiedAt) {
      throw new AccountVerificationStepIncompleteException("IDENTITY");
    }
    const claim = await this.claimStageRequest(
      verification.id,
      AccountVerificationStage.PAYOUT,
      idempotencyKey,
      requestHash,
    );
    if (claim.kind === "REPLAYED") return claim.response;

    try {
      const resolvedAccount = await this.flutterwaveService.resolveBankAccount(
        input.bankCode,
        input.accountNumber,
      );
      const bankNameMatch = this.matchStoredBankAccountName(
        verification,
        resolvedAccount.accountName,
      );
      if (bankNameMatch === NameMatchStatus.MISMATCHED) {
        throw new BankAccountNameMismatchException();
      }

      const response: StageResponse = {
        status: bankNameMatch === NameMatchStatus.REVIEW_REQUIRED ? "REVIEW_REQUIRED" : "VERIFIED",
        bank: {
          bankName: input.bankName,
          accountName: resolvedAccount.accountName,
          accountNumber: this.maskLastFour(resolvedAccount.accountNumber),
          nameMatch: bankNameMatch,
        },
      };
      const verifiedAt = new Date();
      await this.databaseService.$transaction(async (tx) => {
        const lease = await tx.fleetOwnerAccountVerificationStageRequest.updateMany({
          where: {
            id: claim.requestId,
            status: ProviderVerificationStatus.PROCESSING,
            processingExpiresAt: { gt: verifiedAt },
          },
          data: { updatedAt: verifiedAt },
        });
        if (lease.count === 0) throw new AccountVerificationChangedException();

        const advanced = await tx.fleetOwnerAccountVerification.updateMany({
          where: { id: verification.id, status: AccountVerificationStatus.DRAFT },
          data: {
            bankName: input.bankName,
            bankCode: input.bankCode,
            accountNumberLast4: resolvedAccount.accountNumber.slice(-4),
            accountName: resolvedAccount.accountName,
            bankNameMatch,
            payoutVerifiedAt: verifiedAt,
          },
        });
        if (advanced.count === 0) throw new AccountVerificationChangedException();

        await tx.bankDetails.upsert({
          where: { userId },
          create: {
            userId,
            bankName: input.bankName,
            bankCode: input.bankCode,
            accountNumber: resolvedAccount.accountNumber,
            accountName: resolvedAccount.accountName,
            isVerified: false,
            lastVerifiedAt: verifiedAt,
          },
          update: {
            bankName: input.bankName,
            bankCode: input.bankCode,
            accountNumber: resolvedAccount.accountNumber,
            accountName: resolvedAccount.accountName,
            isVerified: false,
            lastVerifiedAt: verifiedAt,
            verificationResponse: null,
          },
        });
        await tx.fleetOwnerAccountVerificationStageRequest.update({
          where: { id: claim.requestId },
          data: { status: ProviderVerificationStatus.SUCCEEDED, response },
        });
      });
      return response;
    } catch (error) {
      throw await this.failStage(claim.requestId, error);
    }
  }

  async saveDrivingCredentialsStage(
    userId: string,
    idempotencyKey: string,
    input: DrivingCredentialsDto,
    documents: AccountDocuments,
  ) {
    await this.assertUserCanVerify(userId);
    const requestHash = this.hashValue({
      stage: AccountVerificationStage.DRIVING,
      input,
      driversLicense: this.fileHash(documents.driversLicense),
      lasdri: this.fileHash(documents.lasdri),
    });
    const replay = await this.findStageReplay(
      userId,
      idempotencyKey,
      AccountVerificationStage.DRIVING,
      requestHash,
    );
    if (replay) return replay;

    const verification = await this.findDraft(userId);
    if (!verification.payoutVerifiedAt) {
      throw new AccountVerificationStepIncompleteException("PAYOUT");
    }
    if (
      verification.accountType === FleetOwnerAccountType.BUSINESS &&
      (input.isOwnerDriver || documents.driversLicense || documents.lasdri)
    ) {
      throw new BusinessOwnerDriverInvalidException();
    }
    const driverLicenseApproved = await this.assertDocumentsValid(
      userId,
      input.isOwnerDriver,
      documents,
    );
    const claim = await this.claimStageRequest(
      verification.id,
      AccountVerificationStage.DRIVING,
      idempotencyKey,
      requestHash,
    );
    if (claim.kind === "REPLAYED") return claim.response;

    const uploaded: Array<{ type: DocumentType; key: string; url: string }> = [];
    try {
      for (const [type, file] of [
        [DocumentType.DRIVERS_LICENSE, documents.driversLicense],
        [DocumentType.LASDRI, documents.lasdri],
      ] as const) {
        if (file) uploaded.push(await this.uploadDocument(userId, verification.id, type, file));
      }
      const previousDocuments = await this.databaseService.documentApproval.findMany({
        where: {
          userId,
          documentType: { in: uploaded.map(({ type }) => type) },
        },
        select: { documentType: true, documentUrl: true },
      });
      const response: StageResponse = {
        status: "COMPLETED",
        isOwnerDriver: input.isOwnerDriver,
        documents: {
          driversLicense: documents.driversLicense
            ? "PENDING"
            : input.isOwnerDriver && driverLicenseApproved
              ? "APPROVED"
              : null,
          lasdri: documents.lasdri ? "PENDING" : null,
        },
      };
      await this.databaseService.$transaction(async (tx) => {
        const completedAt = new Date();
        const lease = await tx.fleetOwnerAccountVerificationStageRequest.updateMany({
          where: {
            id: claim.requestId,
            status: ProviderVerificationStatus.PROCESSING,
            processingExpiresAt: { gt: completedAt },
          },
          data: { updatedAt: completedAt },
        });
        if (lease.count === 0) throw new AccountVerificationChangedException();

        const advanced = await tx.fleetOwnerAccountVerification.updateMany({
          where: { id: verification.id, status: AccountVerificationStatus.DRAFT },
          data: { isOwnerDriver: input.isOwnerDriver, drivingCompletedAt: completedAt },
        });
        if (advanced.count === 0) throw new AccountVerificationChangedException();

        for (const document of uploaded) {
          await tx.documentApproval.upsert({
            where: {
              documentType_userId: { documentType: document.type, userId },
            },
            create: {
              userId,
              documentType: document.type,
              documentUrl: document.url,
            },
            update: {
              documentUrl: document.url,
              status: DocumentStatus.PENDING,
              notes: null,
              approvedAt: null,
              approvedById: null,
            },
          });
        }
        await tx.fleetOwnerAccountVerificationStageRequest.update({
          where: { id: claim.requestId },
          data: { status: ProviderVerificationStatus.SUCCEEDED, response },
        });
      });
      await this.deleteReplacedDocuments(previousDocuments, uploaded);
      return response;
    } catch (error) {
      await this.deleteUploaded(uploaded);
      throw await this.failStage(claim.requestId, error);
    }
  }

  async submitStage(userId: string, idempotencyKey: string) {
    await this.assertUserCanVerify(userId);
    const requestHash = this.hashValue({ stage: AccountVerificationStage.SUBMISSION });
    const replay = await this.findStageReplay(
      userId,
      idempotencyKey,
      AccountVerificationStage.SUBMISSION,
      requestHash,
    );
    if (replay) return replay;

    const verification = await this.findDraft(userId);
    if (!verification.identityVerifiedAt) {
      throw new AccountVerificationStepIncompleteException("IDENTITY");
    }
    if (!verification.payoutVerifiedAt) {
      throw new AccountVerificationStepIncompleteException("PAYOUT");
    }
    if (!verification.drivingCompletedAt || verification.isOwnerDriver === null) {
      throw new AccountVerificationStepIncompleteException("DRIVING");
    }
    const claim = await this.claimStageRequest(
      verification.id,
      AccountVerificationStage.SUBMISSION,
      idempotencyKey,
      requestHash,
    );
    if (claim.kind === "REPLAYED") return claim.response;

    try {
      return await this.databaseService.$transaction(async (tx) => {
        const submittedAt = new Date();
        const lease = await tx.fleetOwnerAccountVerificationStageRequest.updateMany({
          where: {
            id: claim.requestId,
            status: ProviderVerificationStatus.PROCESSING,
            processingExpiresAt: { gt: submittedAt },
          },
          data: { updatedAt: submittedAt },
        });
        if (lease.count === 0) throw new AccountVerificationChangedException();

        const advanced = await tx.fleetOwnerAccountVerification.updateMany({
          where: { id: verification.id, status: AccountVerificationStatus.DRAFT },
          data: { status: AccountVerificationStatus.PROCESSING },
        });
        if (advanced.count === 0) throw new AccountVerificationChangedException();

        const current = await tx.fleetOwnerAccountVerification.findUnique({
          where: { id: verification.id },
        });
        if (!current) throw new AccountVerificationNotFoundException();
        if (!current.identityVerifiedAt) throw new AccountVerificationChangedException();
        if (!current.payoutVerifiedAt) throw new AccountVerificationChangedException();
        if (!current.drivingCompletedAt || current.isOwnerDriver === null) {
          throw new AccountVerificationChangedException();
        }

        let driverLicenseApproved = true;
        if (current.isOwnerDriver) {
          const driverLicense = await tx.documentApproval.findUnique({
            where: {
              documentType_userId: {
                documentType: DocumentType.DRIVERS_LICENSE,
                userId,
              },
            },
            select: { status: true },
          });
          if (!driverLicense || driverLicense.status === DocumentStatus.REJECTED) {
            throw new OwnerDriverLicenseRequiredException();
          }
          driverLicenseApproved = driverLicense.status === DocumentStatus.APPROVED;
        }

        const needsReview =
          current.identityRequiresReview ||
          current.bankNameMatch === NameMatchStatus.REVIEW_REQUIRED ||
          !driverLicenseApproved;
        const status = needsReview
          ? AccountVerificationStatus.REVIEW_REQUIRED
          : AccountVerificationStatus.SUCCEEDED;
        const bank = await tx.bankDetails.updateMany({
          where: { userId },
          data: { isVerified: status === AccountVerificationStatus.SUCCEEDED },
        });
        if (bank.count === 0) throw new AccountVerificationOperationFailedException();

        const userUpdated = await tx.user.updateMany({
          where: { id: userId, emailVerified: true, phoneVerifiedAt: { not: null } },
          data: {
            name: current.legalName,
            isOwnerDriver: current.isOwnerDriver,
            hasOnboarded: true,
            fleetOwnerStatus:
              status === AccountVerificationStatus.SUCCEEDED
                ? FleetOwnerStatus.APPROVED
                : FleetOwnerStatus.PROCESSING,
          },
        });
        if (userUpdated.count === 0) throw new AccountVerificationChangedException();
        const completed = await tx.fleetOwnerAccountVerification.update({
          where: { id: current.id },
          data: { status, submittedAt },
        });
        const response = this.toResponse(completed);
        await tx.fleetOwnerAccountVerificationStageRequest.update({
          where: { id: claim.requestId },
          data: {
            status: ProviderVerificationStatus.SUCCEEDED,
            response: response as Prisma.InputJsonObject,
          },
        });
        return response;
      });
    } catch (error) {
      throw await this.failStage(claim.requestId, error);
    }
  }

  async replaceRejectedDriversLicense(userId: string, file: UploadedAccountDocument) {
    const existing = await this.databaseService.documentApproval.findUnique({
      where: {
        documentType_userId: {
          documentType: DocumentType.DRIVERS_LICENSE,
          userId,
        },
      },
    });
    if (!existing || existing.status !== DocumentStatus.REJECTED) {
      throw new AccountDocumentInvalidException("Only a rejected driver's licence can be replaced");
    }

    const verification = await this.databaseService.fleetOwnerAccountVerification.findFirst({
      where: {
        userId,
        status: AccountVerificationStatus.REVIEW_REQUIRED,
        isOwnerDriver: true,
      },
      select: { id: true },
    });
    if (!verification) {
      throw new AccountVerificationReviewNotPendingException();
    }

    const uploaded = await this.uploadDocument(
      userId,
      verification.id,
      DocumentType.DRIVERS_LICENSE,
      file,
    );
    let updated: Awaited<ReturnType<typeof this.databaseService.documentApproval.update>>;
    try {
      updated = await this.databaseService.$transaction((tx) =>
        tx.documentApproval.update({
          where: { id: existing.id, status: DocumentStatus.REJECTED },
          data: {
            documentUrl: uploaded.url,
            status: DocumentStatus.PENDING,
            notes: null,
            approvedAt: null,
            approvedById: null,
          },
        }),
      );
    } catch {
      await this.deleteUploaded([uploaded]);
      throw new AccountVerificationOperationFailedException();
    }

    await this.deleteObjectWithRetry(existing.documentUrl);
    return updated;
  }

  private async expireStaleVerification(userId: string) {
    await this.databaseService.fleetOwnerAccountVerification.updateMany({
      where: {
        userId,
        status: AccountVerificationStatus.PROCESSING,
        processingExpiresAt: { lte: new Date() },
      },
      data: {
        status: AccountVerificationStatus.FAILED,
        failureReason: AccountVerificationErrorCode.OPERATION_FAILED,
      },
    });
  }

  private findVerificationByKey(userId: string, idempotencyKey: string) {
    return this.databaseService.fleetOwnerAccountVerification.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey } },
    });
  }

  private findActiveVerification(userId: string) {
    return this.databaseService.fleetOwnerAccountVerification.findFirst({
      where: {
        userId,
        status: {
          in: [
            AccountVerificationStatus.DRAFT,
            AccountVerificationStatus.PROCESSING,
            AccountVerificationStatus.REVIEW_REQUIRED,
          ],
        },
      },
      select: { id: true, status: true },
    });
  }

  private async claimVerification(
    userId: string,
    idempotencyKey: string,
    requestHash: string,
    input: CreateAccountVerificationDto,
    accountIsApproved: boolean,
  ) {
    await this.expireStaleVerification(userId);

    if (accountIsApproved) {
      const existing = await this.findVerificationByKey(userId, idempotencyKey);
      if (!existing) throw new AccountAlreadyVerifiedException();
      return { kind: "REPLAYED" as const, response: this.replay(existing, requestHash) };
    }

    try {
      const verification = await this.databaseService.fleetOwnerAccountVerification.create({
        data: {
          userId,
          idempotencyKey,
          requestHash,
          accountType: input.accountType,
          isOwnerDriver: input.isOwnerDriver,
          processingExpiresAt: new Date(Date.now() + PROCESSING_TTL_MS),
        },
      });
      return { kind: "CLAIMED" as const, verification };
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const existing = await this.findVerificationByKey(userId, idempotencyKey);
      if (existing) {
        return { kind: "REPLAYED" as const, response: this.replay(existing, requestHash) };
      }
      const active = await this.findActiveVerification(userId);
      if (active?.status === AccountVerificationStatus.REVIEW_REQUIRED) {
        throw new AccountVerificationReviewPendingException();
      }
      if (active) throw new VerificationRequestInProgressException();
      throw error;
    }
  }

  private async claimIdentityStage(
    userId: string,
    idempotencyKey: string,
    requestHash: string,
    input: AccountIdentityVerificationDto,
    accountIsApproved: boolean,
    attempt = 1,
  ) {
    await this.expireStaleVerification(userId);

    if (accountIsApproved) {
      const existing = await this.findVerificationByKey(userId, idempotencyKey);
      if (!existing) throw new AccountAlreadyVerifiedException();
      return {
        kind: "REPLAYED" as const,
        response: this.replayIdentityStage(existing, requestHash),
      };
    }

    try {
      const verification = await this.databaseService.fleetOwnerAccountVerification.create({
        data: {
          userId,
          idempotencyKey,
          requestHash,
          accountType: input.accountType,
          isOwnerDriver: input.accountType === FleetOwnerAccountType.BUSINESS ? false : undefined,
          processingExpiresAt: new Date(Date.now() + PROCESSING_TTL_MS),
        },
      });
      return { kind: "CLAIMED" as const, verification };
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const existing = await this.findVerificationByKey(userId, idempotencyKey);
      if (existing) {
        return {
          kind: "REPLAYED" as const,
          response: this.replayIdentityStage(existing, requestHash),
        };
      }

      const active = await this.findActiveVerification(userId);
      if (active?.status === AccountVerificationStatus.DRAFT && attempt === 1) {
        const superseded = await this.databaseService.fleetOwnerAccountVerification.updateMany({
          where: { id: active.id, status: AccountVerificationStatus.DRAFT },
          data: {
            status: AccountVerificationStatus.FAILED,
            failureReason: AccountVerificationErrorCode.OPERATION_FAILED,
          },
        });
        if (superseded.count === 1) {
          return this.claimIdentityStage(
            userId,
            idempotencyKey,
            requestHash,
            input,
            accountIsApproved,
            attempt + 1,
          );
        }
      }
      if (active?.status === AccountVerificationStatus.REVIEW_REQUIRED) {
        throw new AccountVerificationReviewPendingException();
      }
      if (active) throw new VerificationRequestInProgressException();
      throw error;
    }
  }

  private async findDraft(userId: string) {
    const verification = await this.databaseService.fleetOwnerAccountVerification.findFirst({
      where: { userId, status: AccountVerificationStatus.DRAFT },
      orderBy: { createdAt: "desc" },
    });
    if (!verification) throw new AccountVerificationNotFoundException();
    return verification;
  }

  private async findStageReplay(
    userId: string,
    idempotencyKey: string,
    stage: AccountVerificationStage,
    requestHash: string,
  ): Promise<StageResponse | undefined> {
    const verification = await this.databaseService.fleetOwnerAccountVerification.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (!verification) return undefined;

    const existing =
      await this.databaseService.fleetOwnerAccountVerificationStageRequest.findUnique({
        where: {
          verificationId_idempotencyKey: {
            verificationId: verification.id,
            idempotencyKey,
          },
        },
      });
    if (!existing) return undefined;
    if (existing.stage !== stage) throw new VerificationIdempotencyKeyReusedException();
    if (existing.requestHash !== requestHash) {
      throw new VerificationIdempotencyKeyReusedException();
    }
    const now = new Date();
    if (
      existing.status === ProviderVerificationStatus.PROCESSING &&
      existing.processingExpiresAt <= now
    ) {
      const expired =
        await this.databaseService.fleetOwnerAccountVerificationStageRequest.updateMany({
          where: {
            id: existing.id,
            status: ProviderVerificationStatus.PROCESSING,
            processingExpiresAt: { lte: now },
          },
          data: {
            status: ProviderVerificationStatus.FAILED,
            failureReason: AccountVerificationErrorCode.VERIFICATION_CHANGED,
          },
        });
      if (expired.count === 1) {
        throw new AccountVerificationChangedException();
      }
      const refreshed =
        await this.databaseService.fleetOwnerAccountVerificationStageRequest.findUnique({
          where: { id: existing.id },
        });
      if (!refreshed) return undefined;
      return this.replayStageRequest(refreshed, requestHash);
    }
    return this.replayStageRequest(existing, requestHash);
  }

  private async claimStageRequest(
    verificationId: string,
    stage: AccountVerificationStage,
    idempotencyKey: string,
    requestHash: string,
    attempt = 1,
  ) {
    await this.databaseService.fleetOwnerAccountVerificationStageRequest.updateMany({
      where: {
        verificationId,
        stage,
        status: ProviderVerificationStatus.PROCESSING,
        processingExpiresAt: { lte: new Date() },
      },
      data: {
        status: ProviderVerificationStatus.FAILED,
        failureReason: AccountVerificationErrorCode.VERIFICATION_CHANGED,
      },
    });

    try {
      const request = await this.databaseService.fleetOwnerAccountVerificationStageRequest.create({
        data: {
          verificationId,
          stage,
          idempotencyKey,
          requestHash,
          processingExpiresAt: new Date(Date.now() + PROCESSING_TTL_MS),
        },
        select: { id: true },
      });
      return { kind: "CLAIMED" as const, requestId: request.id };
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const existing =
        await this.databaseService.fleetOwnerAccountVerificationStageRequest.findUnique({
          where: { verificationId_idempotencyKey: { verificationId, idempotencyKey } },
        });
      if (!existing) {
        const active =
          await this.databaseService.fleetOwnerAccountVerificationStageRequest.findFirst({
            where: {
              verificationId,
              stage,
              status: ProviderVerificationStatus.PROCESSING,
            },
            select: { id: true },
          });
        if (active) throw new VerificationRequestInProgressException();
        if (attempt === 1) {
          return this.claimStageRequest(
            verificationId,
            stage,
            idempotencyKey,
            requestHash,
            attempt + 1,
          );
        }
        throw error;
      }
      return {
        kind: "REPLAYED" as const,
        response: this.replayStageRequest(existing, requestHash),
      };
    }
  }

  private replayStageRequest(
    request: {
      requestHash: string;
      status: ProviderVerificationStatus;
      failureReason: string | null;
      response: Prisma.JsonValue | null;
    },
    requestHash: string,
  ): StageResponse {
    if (request.requestHash !== requestHash) {
      throw new VerificationIdempotencyKeyReusedException();
    }
    if (request.status === ProviderVerificationStatus.PROCESSING) {
      throw new VerificationRequestInProgressException();
    }
    if (request.status === ProviderVerificationStatus.FAILED) {
      throw this.failureException(request.failureReason);
    }
    if (
      !request.response ||
      Array.isArray(request.response) ||
      typeof request.response !== "object"
    ) {
      throw new AccountVerificationOperationFailedException();
    }
    return request.response as StageResponse;
  }

  private async assertUserCanVerify(userId: string) {
    const user = await this.databaseService.user.findUnique({
      where: { id: userId },
      select: {
        emailVerified: true,
        phoneVerifiedAt: true,
        fleetOwnerStatus: true,
      },
    });
    if (!user?.emailVerified) throw new AccountEmailNotVerifiedException();
    if (!user.phoneVerifiedAt) throw new AccountPhoneNotVerifiedException();
    return user;
  }

  private async assertDocumentsValid(
    userId: string,
    isOwnerDriver: boolean,
    documents: AccountDocuments,
  ): Promise<boolean> {
    if (!isOwnerDriver && (documents.driversLicense || documents.lasdri)) {
      throw new AccountDocumentInvalidException(
        "Driver documents can only be uploaded for an owner-driver",
      );
    }
    if (!isOwnerDriver) return true;
    if (documents.driversLicense) return false;

    const existingDriverLicense = await this.databaseService.documentApproval.findUnique({
      where: {
        documentType_userId: { documentType: DocumentType.DRIVERS_LICENSE, userId },
      },
      select: { status: true },
    });
    if (!existingDriverLicense || existingDriverLicense.status === DocumentStatus.REJECTED) {
      throw new OwnerDriverLicenseRequiredException();
    }
    return existingDriverLicense.status === DocumentStatus.APPROVED;
  }

  private async verifyIdentity(
    input: AccountIdentityVerificationDto,
  ): Promise<VerifiedAccountIdentity> {
    let identity: PremblyNinResult;
    try {
      identity = await this.premblyService.verifyNin(input.nin);
    } catch (error) {
      if (error instanceof PremblyError && error.kind === "REJECTED") {
        throw new NinNotVerifiedException();
      }
      throw error;
    }
    const legalName = this.fullName(identity);
    if (input.accountType === FleetOwnerAccountType.INDIVIDUAL) {
      return { identity, legalName };
    }

    let business: PremblyCacResult;
    try {
      business = await this.premblyService.verifyCac(
        input.registrationNumber,
        input.registrationType,
        input.businessName,
      );
    } catch (error) {
      if (error instanceof PremblyError && error.kind === "REJECTED") {
        throw new CacNotVerifiedException();
      }
      throw error;
    }
    if (business.status && business.status !== "ACTIVE") {
      throw new BusinessInactiveException();
    }
    const businessNameMatch = this.compareBusinessNames(input.businessName, business.businessName);
    if (businessNameMatch === NameMatchStatus.MISMATCHED) {
      throw new BusinessNameMismatchException();
    }
    return {
      identity,
      legalName,
      business,
      businessNameMatch,
      representativeNameMatch: this.matchRepresentative(identity, business.directors),
    };
  }

  private matchBankAccountName(
    accountType: FleetOwnerAccountType,
    identity: PremblyNinResult,
    business: PremblyCacResult | undefined,
    accountName: string,
  ): NameMatchStatus {
    return accountType === FleetOwnerAccountType.BUSINESS && business
      ? this.compareBusinessNames(business.businessName, accountName)
      : this.comparePersonName(identity, accountName);
  }

  private matchStoredBankAccountName(
    verification: FleetOwnerAccountVerification,
    accountName: string,
  ): NameMatchStatus {
    if (verification.accountType === FleetOwnerAccountType.BUSINESS && verification.businessName) {
      return this.compareBusinessNames(verification.businessName, accountName);
    }
    if (!verification.identityFirstName || !verification.identityLastName) {
      throw new AccountVerificationOperationFailedException();
    }
    return this.comparePersonName(
      {
        firstName: verification.identityFirstName,
        lastName: verification.identityLastName,
      },
      accountName,
    );
  }

  async getStatus(userId: string) {
    const user = await this.databaseService.user.findUnique({
      where: { id: userId },
      select: {
        emailVerified: true,
        phoneNumber: true,
        phoneVerifiedAt: true,
        hasOnboarded: true,
        isOwnerDriver: true,
        fleetOwnerStatus: true,
        bankDetails: {
          select: {
            bankName: true,
            accountName: true,
            accountNumber: true,
            isVerified: true,
          },
        },
        documents: {
          where: { documentType: { in: [DocumentType.DRIVERS_LICENSE, DocumentType.LASDRI] } },
          select: { documentType: true, status: true },
        },
        accountVerifications: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });
    if (!user) throw new AccountVerificationOperationFailedException();

    const verification = user.accountVerifications[0] ?? null;
    const driversLicense = user.documents.find(
      ({ documentType }) => documentType === DocumentType.DRIVERS_LICENSE,
    );
    const lasdri = user.documents.find(({ documentType }) => documentType === DocumentType.LASDRI);
    const progress = onboardingProgress(verification);
    const requiredActions: string[] = [];
    if (!user.emailVerified) requiredActions.push("VERIFY_EMAIL");
    if (!user.phoneVerifiedAt) requiredActions.push("VERIFY_PHONE");
    if (
      (!verification && user.fleetOwnerStatus !== FleetOwnerStatus.APPROVED) ||
      verification?.status === AccountVerificationStatus.FAILED ||
      verification?.status === AccountVerificationStatus.DRAFT
    ) {
      requiredActions.push("VERIFY_ACCOUNT");
    }
    if (
      user.isOwnerDriver &&
      (!driversLicense || driversLicense.status === DocumentStatus.REJECTED)
    ) {
      requiredActions.push("UPLOAD_DRIVERS_LICENSE");
    }

    let status = "ACTION_REQUIRED";
    if (requiredActions.length === 0) {
      if (verification?.status === AccountVerificationStatus.REVIEW_REQUIRED) {
        status = "UNDER_REVIEW";
      } else if (user.hasOnboarded && user.fleetOwnerStatus === FleetOwnerStatus.APPROVED) {
        status = "VERIFIED";
      }
    }

    const identity =
      verification && progress.identityComplete
        ? {
            status: verification.identityRequiresReview
              ? AccountVerificationStatus.REVIEW_REQUIRED
              : AccountVerificationStatus.SUCCEEDED,
            legalName: verification.legalName,
            businessName: verification.businessName,
          }
        : null;
    const bank =
      user.bankDetails && progress.payoutComplete
        ? {
            bankName: user.bankDetails.bankName,
            accountName: user.bankDetails.accountName,
            accountNumber: this.maskLastFour(user.bankDetails.accountNumber),
            verified: user.bankDetails.isVerified,
          }
        : null;

    return {
      status,
      accountType: verification?.accountType ?? null,
      isOwnerDriver: verification?.isOwnerDriver ?? user.isOwnerDriver,
      emailVerified: user.emailVerified,
      phone: {
        number: user.phoneNumber ? this.maskLastFour(user.phoneNumber) : null,
        verified: user.phoneVerifiedAt !== null,
      },
      identity,
      bank,
      documents: {
        driversLicense: driversLicense?.status ?? null,
        lasdri: lasdri?.status ?? null,
      },
      steps: {
        contact: user.emailVerified && user.phoneVerifiedAt ? "VERIFIED" : "PENDING",
        identity: reviewedStepStatus(
          progress.identityComplete,
          verification?.identityRequiresReview ?? false,
        ),
        payout: reviewedStepStatus(
          progress.payoutComplete,
          verification?.bankNameMatch === NameMatchStatus.REVIEW_REQUIRED,
        ),
        driving: drivingStepStatus(verification, progress.drivingComplete),
        submission: submissionStepStatus(verification),
      },
      nextAction: nextOnboardingAction(
        user.emailVerified,
        user.phoneVerifiedAt !== null,
        progress,
        verification?.status,
      ),
      requiredActions,
    };
  }

  async approve(verificationId: string, reviewerId: string) {
    return this.databaseService.$transaction(async (tx) => {
      const verification = await tx.fleetOwnerAccountVerification.findUnique({
        where: { id: verificationId },
        include: {
          user: {
            select: { emailVerified: true, phoneVerifiedAt: true },
          },
        },
      });
      if (!verification) throw new AccountVerificationReviewNotFoundException();
      if (verification.status !== AccountVerificationStatus.REVIEW_REQUIRED) {
        throw new AccountVerificationReviewNotPendingException();
      }
      if (!verification.user.emailVerified) throw new AccountEmailNotVerifiedException();
      if (!verification.user.phoneVerifiedAt) throw new AccountPhoneNotVerifiedException();

      if (verification.isOwnerDriver) {
        const driversLicense = await tx.documentApproval.findUnique({
          where: {
            documentType_userId: {
              documentType: DocumentType.DRIVERS_LICENSE,
              userId: verification.userId,
            },
          },
          select: { status: true },
        });
        if (driversLicense?.status !== DocumentStatus.APPROVED) {
          throw new OwnerDriverLicenseNotApprovedException();
        }
      }

      const reviewedAt = new Date();
      const updated = await tx.fleetOwnerAccountVerification.updateMany({
        where: { id: verificationId, status: AccountVerificationStatus.REVIEW_REQUIRED },
        data: {
          status: AccountVerificationStatus.SUCCEEDED,
          reviewedById: reviewerId,
          reviewedAt,
          reviewNotes: null,
        },
      });
      if (updated.count === 0) throw new AccountVerificationReviewNotPendingException();

      const bank = await tx.bankDetails.updateMany({
        where: { userId: verification.userId },
        data: { isVerified: true, lastVerifiedAt: reviewedAt },
      });
      if (bank.count === 0) throw new AccountVerificationOperationFailedException();

      await tx.user.update({
        where: { id: verification.userId },
        data: {
          hasOnboarded: true,
          fleetOwnerStatus: FleetOwnerStatus.APPROVED,
        },
      });
      const completed = await tx.fleetOwnerAccountVerification.findUnique({
        where: { id: verificationId },
      });
      if (!completed) throw new AccountVerificationReviewNotFoundException();
      return this.toResponse(completed);
    });
  }

  async reject(verificationId: string, reviewerId: string, notes: string) {
    return this.databaseService.$transaction(async (tx) => {
      const verification = await tx.fleetOwnerAccountVerification.findUnique({
        where: { id: verificationId },
        select: { userId: true, status: true },
      });
      if (!verification) throw new AccountVerificationReviewNotFoundException();
      if (verification.status !== AccountVerificationStatus.REVIEW_REQUIRED) {
        throw new AccountVerificationReviewNotPendingException();
      }

      const rejected = await tx.fleetOwnerAccountVerification.updateMany({
        where: { id: verificationId, status: AccountVerificationStatus.REVIEW_REQUIRED },
        data: {
          status: AccountVerificationStatus.FAILED,
          failureReason: AccountVerificationErrorCode.MANUAL_REVIEW_REJECTED,
          reviewedById: reviewerId,
          reviewedAt: new Date(),
          reviewNotes: notes,
        },
      });
      if (rejected.count === 0) throw new AccountVerificationReviewNotPendingException();

      await tx.bankDetails.updateMany({
        where: { userId: verification.userId },
        data: { isVerified: false },
      });
      await tx.user.update({
        where: { id: verification.userId },
        data: {
          hasOnboarded: false,
          fleetOwnerStatus: FleetOwnerStatus.ON_HOLD,
        },
      });
      return { success: true };
    });
  }

  private replay(verification: FleetOwnerAccountVerification, requestHash: string) {
    if (verification.requestHash !== requestHash) {
      throw new VerificationIdempotencyKeyReusedException();
    }
    if (verification.status === AccountVerificationStatus.PROCESSING) {
      throw new VerificationRequestInProgressException();
    }
    if (verification.status === AccountVerificationStatus.FAILED) {
      throw this.failureException(verification.failureReason);
    }
    return this.toResponse(verification);
  }

  private comparePersonName(
    person: Pick<PremblyNinResult, "firstName" | "lastName">,
    candidateName: string,
  ): NameMatchStatus {
    const candidate = new Set(this.nameTokens(candidateName, PERSON_TITLES));
    const firstMatches = candidate.has(this.normalizeToken(person.firstName));
    const lastMatches = candidate.has(this.normalizeToken(person.lastName));
    if (firstMatches && lastMatches) return NameMatchStatus.MATCHED;
    if (firstMatches || lastMatches) return NameMatchStatus.REVIEW_REQUIRED;
    return NameMatchStatus.MISMATCHED;
  }

  private compareBusinessNames(expected: string, candidate: string): NameMatchStatus {
    const expectedTokens = this.nameTokens(expected, CORPORATE_SUFFIXES);
    const candidateTokens = this.nameTokens(candidate, CORPORATE_SUFFIXES);
    if (expectedTokens.length === 0 || candidateTokens.length === 0) {
      return NameMatchStatus.MISMATCHED;
    }
    const expectedSet = new Set(expectedTokens);
    const candidateSet = new Set(candidateTokens);
    if (
      expectedSet.size === candidateSet.size &&
      [...expectedSet].every((token) => candidateSet.has(token))
    ) {
      return NameMatchStatus.MATCHED;
    }
    const overlap = [...expectedSet].filter((token) => candidateSet.has(token)).length;
    return overlap / Math.max(expectedSet.size, candidateSet.size) >= 0.6
      ? NameMatchStatus.REVIEW_REQUIRED
      : NameMatchStatus.MISMATCHED;
  }

  private matchRepresentative(
    identity: PremblyNinResult,
    directors: Array<{ firstName: string; lastName: string }>,
  ): NameMatchStatus {
    if (directors.length === 0) return NameMatchStatus.REVIEW_REQUIRED;
    const matches = new Set(
      directors.map((director) =>
        this.comparePersonName(identity, `${director.firstName} ${director.lastName}`),
      ),
    );
    return matches.has(NameMatchStatus.MATCHED)
      ? NameMatchStatus.MATCHED
      : NameMatchStatus.REVIEW_REQUIRED;
  }

  private nameTokens(value: string, ignored: Set<string>): string[] {
    return value
      .normalize("NFKD")
      .replaceAll(/\p{M}/gu, "")
      .toUpperCase()
      .split(/[^A-Z0-9]+/)
      .map((token) => this.normalizeToken(token))
      .filter((token) => token && !ignored.has(token));
  }

  private normalizeToken(value: string): string {
    return value.normalize("NFKD").replaceAll(/\p{M}/gu, "").trim().toUpperCase();
  }

  private fullName(identity: PremblyNinResult): string {
    return [identity.firstName, identity.middleName, identity.lastName].filter(Boolean).join(" ");
  }

  private hashRequest(input: CreateAccountVerificationDto, documents: AccountDocuments): string {
    return this.hashValue({
      ...input,
      driversLicense: this.fileHash(documents.driversLicense),
      lasdri: this.fileHash(documents.lasdri),
    });
  }

  private hashValue(value: unknown): string {
    return createHmac("sha256", this.hashKey).update(JSON.stringify(value)).digest("hex");
  }

  private fileHash(file?: UploadedAccountDocument): string | null {
    return file ? createHash("sha256").update(file.buffer).digest("hex") : null;
  }

  private async uploadDocument(
    userId: string,
    verificationId: string,
    type: DocumentType,
    file: UploadedAccountDocument,
  ) {
    const safeName = file.originalname.replaceAll(/[^a-zA-Z0-9.-]/g, "_");
    const key = `${userId}/${verificationId}/documents/${type.toLowerCase()}-${randomUUID()}-${safeName}`;
    const url = await this.storageService.uploadBuffer(file.buffer, key, file.mimetype);
    return { type, key, url };
  }

  private async deleteUploaded(uploaded: Array<{ key: string }>): Promise<void> {
    await Promise.all(uploaded.map(({ key }) => this.deleteObjectWithRetry(key)));
  }

  private async deleteReplacedDocuments(
    previous: Array<{ documentType: DocumentType; documentUrl: string }>,
    replacements: Array<{ url: string }> = [],
  ): Promise<void> {
    const replacementUrls = new Set(replacements.map(({ url }) => url));
    await this.deleteUploaded(
      previous
        .filter(({ documentUrl }) => !replacementUrls.has(documentUrl))
        .map(({ documentUrl }) => ({ key: documentUrl })),
    );
  }

  private async deleteObjectWithRetry(key: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.storageService.deleteObjectByKey(key);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    this.logger.warn(
      { error: lastError instanceof Error ? lastError.message : String(lastError) },
      "Failed to delete an unreferenced account document after retries",
    );
  }

  private async fail(id: string, error: unknown): Promise<AccountVerificationException> {
    const exception = this.toException(error);
    await this.databaseService.fleetOwnerAccountVerification
      .updateMany({
        where: { id, status: AccountVerificationStatus.PROCESSING },
        data: { status: AccountVerificationStatus.FAILED, failureReason: exception.getErrorCode() },
      })
      .catch(() => undefined);
    return exception;
  }

  private async failStage(
    requestId: string,
    error: unknown,
  ): Promise<AccountVerificationException> {
    const exception = this.toException(error);
    await this.databaseService.fleetOwnerAccountVerificationStageRequest
      .updateMany({
        where: { id: requestId, status: ProviderVerificationStatus.PROCESSING },
        data: {
          status: ProviderVerificationStatus.FAILED,
          failureReason: exception.getErrorCode(),
        },
      })
      .catch(() => undefined);
    return exception;
  }

  private replayIdentityStage(
    verification: FleetOwnerAccountVerification,
    requestHash: string,
  ): StageResponse {
    if (verification.requestHash !== requestHash) {
      throw new VerificationIdempotencyKeyReusedException();
    }
    if (verification.status === AccountVerificationStatus.PROCESSING) {
      throw new VerificationRequestInProgressException();
    }
    if (verification.status === AccountVerificationStatus.FAILED) {
      throw this.failureException(verification.failureReason);
    }
    if (!verification.identityVerifiedAt) {
      throw new AccountVerificationOperationFailedException();
    }
    return this.toIdentityStageResponse(verification);
  }

  private toException(error: unknown): AccountVerificationException {
    if (error instanceof AccountVerificationException) return error;
    if (error instanceof PremblyError) {
      return new ProviderVerificationException(error.kind);
    }
    if (error instanceof FlutterwaveError) {
      return error.statusCode !== undefined && [400, 404, 422].includes(error.statusCode)
        ? new BankAccountUnresolvedException()
        : new BankAccountProviderUnavailableException();
    }
    this.logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Unexpected fleet-owner account verification failure",
    );
    return new AccountVerificationOperationFailedException();
  }

  private failureException(reason: string | null): AccountVerificationException {
    switch (reason) {
      case AccountVerificationErrorCode.NIN_NOT_VERIFIED:
        return new NinNotVerifiedException();
      case AccountVerificationErrorCode.CAC_NOT_VERIFIED:
        return new CacNotVerifiedException();
      case VerificationErrorCode.PROVIDER_REJECTED:
        return new ProviderVerificationException("REJECTED");
      case VerificationErrorCode.PROVIDER_INVALID_RESPONSE:
        return new ProviderVerificationException("INVALID_RESPONSE");
      case VerificationErrorCode.PROVIDER_UNAVAILABLE:
        return new ProviderVerificationException("UNAVAILABLE");
      case AccountVerificationErrorCode.BANK_ACCOUNT_UNRESOLVED:
        return new BankAccountUnresolvedException();
      case AccountVerificationErrorCode.BANK_PROVIDER_UNAVAILABLE:
        return new BankAccountProviderUnavailableException();
      case AccountVerificationErrorCode.BANK_ACCOUNT_NAME_MISMATCH:
        return new BankAccountNameMismatchException();
      case AccountVerificationErrorCode.BUSINESS_INACTIVE:
        return new BusinessInactiveException();
      case AccountVerificationErrorCode.BUSINESS_NAME_MISMATCH:
        return new BusinessNameMismatchException();
      case AccountVerificationErrorCode.VERIFICATION_CHANGED:
        return new AccountVerificationChangedException();
      case AccountVerificationErrorCode.VERIFICATION_NOT_FOUND:
        return new AccountVerificationNotFoundException();
      case AccountVerificationErrorCode.DRIVER_LICENSE_REQUIRED:
        return new OwnerDriverLicenseRequiredException();
      case AccountVerificationErrorCode.MANUAL_REVIEW_REJECTED:
        return new AccountManualReviewRejectedException();
      default:
        return new AccountVerificationOperationFailedException();
    }
  }

  private toResponse(verification: FleetOwnerAccountVerification) {
    return {
      id: verification.id,
      status: verification.status,
      accountType: verification.accountType,
      isOwnerDriver: verification.isOwnerDriver,
      legalName: verification.legalName,
      businessName: verification.businessName,
      bank: verification.accountName
        ? {
            bankName: verification.bankName,
            accountName: verification.accountName,
            accountNumber: verification.accountNumberLast4
              ? `******${verification.accountNumberLast4}`
              : null,
            nameMatch: verification.bankNameMatch,
          }
        : null,
    };
  }

  private toIdentityStageResponse(verification: FleetOwnerAccountVerification): StageResponse {
    return {
      id: verification.id,
      status: verification.identityRequiresReview ? "REVIEW_REQUIRED" : "VERIFIED",
      accountType: verification.accountType,
      legalName: verification.legalName,
      businessName: verification.businessName,
    };
  }

  private maskLastFour(value: string): string {
    return `${"*".repeat(Math.max(0, value.length - 4))}${value.slice(-4)}`;
  }
}
