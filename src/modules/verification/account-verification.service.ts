import { createHash, createHmac } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  AccountVerificationStatus,
  DocumentStatus,
  DocumentType,
  FleetOwnerAccountType,
  type FleetOwnerAccountVerification,
  FleetOwnerStatus,
  NameMatchStatus,
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
  AccountVerificationException,
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
        await tx.bankDetails.upsert({
          where: { userId },
          create: {
            userId,
            bankName: input.bankName,
            bankCode: input.bankCode,
            accountNumber: resolvedAccount.accountNumber,
            accountName: resolvedAccount.accountName,
            isVerified: status === AccountVerificationStatus.SUCCEEDED,
            lastVerifiedAt: new Date(),
          },
          update: {
            bankName: input.bankName,
            bankCode: input.bankCode,
            accountNumber: resolvedAccount.accountNumber,
            accountName: resolvedAccount.accountName,
            isVerified: status === AccountVerificationStatus.SUCCEEDED,
            lastVerifiedAt: new Date(),
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
            legalName,
            businessName: business?.businessName,
            businessNameMatch,
            registrationNumber: business?.registrationNumber,
            registrationType: business?.registrationType,
            identityProviderRef: identity.reference,
            businessProviderRef: business?.reference,
            bankName: input.bankName,
            bankCode: input.bankCode,
            accountNumberLast4: resolvedAccount.accountNumber.slice(-4),
            accountName: resolvedAccount.accountName,
            bankNameMatch,
            representativeNameMatch,
          },
        });
      });

      await this.deleteReplacedDocuments(previousDocuments);
      return this.toResponse(completed);
    } catch (error) {
      await this.deleteUploaded(uploaded);
      throw await this.fail(verification.id, error);
    }
  }

  private async claimVerification(
    userId: string,
    idempotencyKey: string,
    requestHash: string,
    input: CreateAccountVerificationDto,
    accountIsApproved: boolean,
  ) {
    const findExisting = () =>
      this.databaseService.fleetOwnerAccountVerification.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey } },
      });

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

    if (accountIsApproved) {
      const existing = await findExisting();
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
      const existing = await findExisting();
      if (existing) {
        return { kind: "REPLAYED" as const, response: this.replay(existing, requestHash) };
      }
      const active = await this.databaseService.fleetOwnerAccountVerification.findFirst({
        where: {
          userId,
          status: {
            in: [AccountVerificationStatus.PROCESSING, AccountVerificationStatus.REVIEW_REQUIRED],
          },
        },
        select: { status: true },
      });
      if (active?.status === AccountVerificationStatus.REVIEW_REQUIRED) {
        throw new AccountVerificationReviewPendingException();
      }
      if (active) throw new VerificationRequestInProgressException();
      throw error;
    }
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
    input: CreateAccountVerificationDto,
  ): Promise<VerifiedAccountIdentity> {
    const identity = await this.premblyService.verifyNin(input.nin);
    const legalName = this.fullName(identity);
    if (input.accountType === FleetOwnerAccountType.INDIVIDUAL) {
      return { identity, legalName };
    }

    const business = await this.premblyService.verifyCac(
      input.registrationNumber,
      input.registrationType,
      input.businessName,
    );
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
    const requiredActions: string[] = [];
    if (!user.emailVerified) requiredActions.push("VERIFY_EMAIL");
    if (!user.phoneVerifiedAt) requiredActions.push("VERIFY_PHONE");
    if (
      (!verification && user.fleetOwnerStatus !== FleetOwnerStatus.APPROVED) ||
      verification?.status === AccountVerificationStatus.FAILED
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
    if (requiredActions.length > 0) {
      status = "ACTION_REQUIRED";
    } else if (verification?.status === AccountVerificationStatus.REVIEW_REQUIRED) {
      status = "UNDER_REVIEW";
    } else if (user.hasOnboarded && user.fleetOwnerStatus === FleetOwnerStatus.APPROVED) {
      status = "VERIFIED";
    }

    return {
      status,
      accountType: verification?.accountType ?? null,
      isOwnerDriver: user.isOwnerDriver,
      emailVerified: user.emailVerified,
      phone: {
        number: user.phoneNumber ? this.maskLastFour(user.phoneNumber) : null,
        verified: user.phoneVerifiedAt !== null,
      },
      identity: verification
        ? {
            status: verification.status,
            legalName: verification.legalName,
            businessName: verification.businessName,
          }
        : null,
      bank: user.bankDetails
        ? {
            bankName: user.bankDetails.bankName,
            accountName: user.bankDetails.accountName,
            accountNumber: this.maskLastFour(user.bankDetails.accountNumber),
            verified: user.bankDetails.isVerified,
          }
        : null,
      documents: {
        driversLicense: driversLicense?.status ?? null,
        lasdri: lasdri?.status ?? null,
      },
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
    const fileHash = (file?: UploadedAccountDocument) =>
      file ? createHash("sha256").update(file.buffer).digest("hex") : null;
    return createHmac("sha256", this.hashKey)
      .update(
        JSON.stringify({
          ...input,
          driversLicense: fileHash(documents.driversLicense),
          lasdri: fileHash(documents.lasdri),
        }),
      )
      .digest("hex");
  }

  private async uploadDocument(
    userId: string,
    verificationId: string,
    type: DocumentType,
    file: UploadedAccountDocument,
  ) {
    const safeName = file.originalname.replaceAll(/[^a-zA-Z0-9.-]/g, "_");
    const key = `${userId}/${verificationId}/documents/${type.toLowerCase()}-${safeName}`;
    const url = await this.storageService.uploadBuffer(file.buffer, key, file.mimetype);
    return { type, key, url };
  }

  private async deleteUploaded(uploaded: Array<{ key: string }>): Promise<void> {
    await Promise.all(uploaded.map(({ key }) => this.deleteObjectWithRetry(key)));
  }

  private async deleteReplacedDocuments(
    previous: Array<{ documentType: DocumentType; documentUrl: string }>,
  ): Promise<void> {
    await this.deleteUploaded(previous.map(({ documentUrl }) => ({ key: documentUrl })));
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

  private maskLastFour(value: string): string {
    return `${"*".repeat(Math.max(0, value.length - 4))}${value.slice(-4)}`;
  }
}
