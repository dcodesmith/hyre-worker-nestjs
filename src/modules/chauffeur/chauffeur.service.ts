import { createHmac, randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ChauffeurApprovalStatus,
  type ChauffeurVerification,
  ChauffeurVerificationStage,
  ChauffeurVerificationStatus,
  ProviderVerificationStatus,
} from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { toLogError } from "../../common/logging/error-logging.helper";
import type { EnvConfig } from "../../config/env.config";
import { getEmailPublicEnv } from "../../email-public-env";
import { maskEmail } from "../../shared/helper";
import { renderChauffeurInvitationEmail } from "../../templates/emails";
import { USER } from "../auth/auth.const";
import {
  DatabaseService,
  isUniqueConstraintError,
  lockUserRow,
} from "../database/database.service";
import { EmailService } from "../email/email.service";
import type { PremblyDriversLicenseResult } from "../prembly/prembly.interface";
import { PremblyError, PremblyService } from "../prembly/prembly.service";
import { StorageService } from "../storage/storage.service";
import {
  PhoneVerificationCodeInvalidException,
  PhoneVerificationProviderUnavailableException,
} from "../verification/account-verification.error";
import { PhoneVerificationService } from "../verification/phone-verification.service";
import type {
  CreateChauffeurInvitationDto,
  ListChauffeursQueryDto,
  UpdateChauffeurDto,
  UploadedChauffeurSelfie,
  VerifyChauffeurDrivingDto,
  VerifyChauffeurNinDto,
} from "./chauffeur.dto";
import {
  ChauffeurAccountConflictException,
  ChauffeurBiometricNotVerifiedException,
  ChauffeurErrorCode,
  ChauffeurException,
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
import { ChauffeurImageService } from "./chauffeur-image.service";

const INVITE_TTL_MS = 48 * 60 * 60 * 1000;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const PROCESSING_LEASE_MS = 2 * 60 * 1000;
const MINIMUM_CHAUFFEUR_AGE = 21;
const MINIMUM_LIVENESS_CONFIDENCE = 0.8;
const MINIMUM_FACE_MATCH_CONFIDENCE = 80;

const COMPLIANCE_REQUIREMENTS = [
  { type: "LASDRI", label: "LASDRI certificate or card", required: false },
  { type: "LASRRA", label: "LASRRA / LAG-ID card", required: false },
  { type: "DRIVER_BADGE", label: "Lagos driver badge", required: false },
] as const;

type StageClaim = { requestId: string; replay: boolean };

@Injectable()
export class ChauffeurService {
  private readonly hashKey: string;

  constructor(
    configService: ConfigService<EnvConfig, true>,
    private readonly databaseService: DatabaseService,
    private readonly emailService: EmailService,
    private readonly phoneVerificationService: PhoneVerificationService,
    private readonly premblyService: PremblyService,
    private readonly imageService: ChauffeurImageService,
    private readonly storageService: StorageService,
    private readonly logger: PinoLogger,
  ) {
    this.hashKey = configService.get("HMAC_KEY", { infer: true });
    this.logger.setContext(ChauffeurService.name);
  }

  async createInvitation(
    fleetOwnerId: string,
    idempotencyKey: string,
    input: CreateChauffeurInvitationDto,
  ) {
    const idempotencyHash = this.hash(idempotencyKey);
    const requestHash = this.hashJson(input);
    const replay = await this.databaseService.chauffeurVerification.findUnique({
      where: {
        fleetOwnerId_invitationIdempotencyKey: {
          fleetOwnerId,
          invitationIdempotencyKey: idempotencyHash,
        },
      },
      include: {
        chauffeur: { select: { image: true, chauffeurDisabledAt: true } },
      },
    });
    if (replay) {
      if (replay.invitationRequestHash !== requestHash) {
        throw new ChauffeurIdempotencyKeyReusedException();
      }
      return this.toOwnerRecord(replay);
    }

    const owner = await this.databaseService.user.findUnique({
      where: { id: fleetOwnerId },
      select: { id: true, name: true, isOwnerDriver: true },
    });
    if (!owner) {
      throw new ChauffeurOperationFailedException();
    }
    if (owner.isOwnerDriver) {
      throw new ChauffeurInvitationNotAllowedException();
    }

    await this.removeReplaceableInvitation(fleetOwnerId, input.email);
    const token = randomBytes(32).toString("base64url");
    let invitation: ChauffeurVerification;
    try {
      invitation = await this.databaseService.chauffeurVerification.create({
        data: {
          fleetOwnerId,
          name: input.name,
          email: input.email,
          phoneNumber: input.phoneNumber,
          invitationIdempotencyKey: idempotencyHash,
          invitationRequestHash: requestHash,
          inviteTokenHash: this.hash(token),
          inviteExpiresAt: new Date(Date.now() + INVITE_TTL_MS),
        },
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
      const concurrentReplay = await this.databaseService.chauffeurVerification.findUnique({
        where: {
          fleetOwnerId_invitationIdempotencyKey: {
            fleetOwnerId,
            invitationIdempotencyKey: idempotencyHash,
          },
        },
        include: {
          chauffeur: { select: { image: true, chauffeurDisabledAt: true } },
        },
      });
      if (concurrentReplay?.invitationRequestHash === requestHash) {
        return this.toOwnerRecord(concurrentReplay);
      }
      throw concurrentReplay
        ? new ChauffeurIdempotencyKeyReusedException()
        : new ChauffeurInvitationExistsException();
    }

    try {
      const inviteUrl = new URL("/chauffeur/onboarding", getEmailPublicEnv().websiteUrl);
      inviteUrl.searchParams.set("token", token);
      await this.emailService.sendEmail({
        to: invitation.email,
        subject: `${owner.name ?? "Your fleet owner"} invited you to join Tripdly`,
        html: await renderChauffeurInvitationEmail({
          recipientName: invitation.name,
          fleetOwnerName: owner.name ?? "Your fleet owner",
          inviteUrl: inviteUrl.toString(),
        }),
      });
    } catch (error) {
      await this.databaseService.chauffeurVerification.deleteMany({
        where: { id: invitation.id, inviteAcceptedAt: null },
      });
      throw error;
    }

    this.logger.info(
      { fleetOwnerId, invitationId: invitation.id, recipient: maskEmail(invitation.email) },
      "Sent chauffeur invitation",
    );
    return this.toOwnerRecord(invitation);
  }

  private async removeReplaceableInvitation(fleetOwnerId: string, email: string): Promise<void> {
    const existing = await this.databaseService.chauffeurVerification.findUnique({
      where: { fleetOwnerId_email: { fleetOwnerId, email } },
      select: {
        id: true,
        status: true,
        inviteAcceptedAt: true,
        inviteExpiresAt: true,
        sessionExpiresAt: true,
      },
    });
    if (!existing) {
      return;
    }

    const now = new Date();
    const canReplace =
      existing.status !== ChauffeurVerificationStatus.APPROVED &&
      ((!existing.inviteAcceptedAt && existing.inviteExpiresAt <= now) ||
        (existing.inviteAcceptedAt &&
          (!existing.sessionExpiresAt || existing.sessionExpiresAt <= now)));
    if (!canReplace) {
      throw new ChauffeurInvitationExistsException();
    }

    const deleted = await this.databaseService.chauffeurVerification.deleteMany({
      where: { id: existing.id, status: { not: ChauffeurVerificationStatus.APPROVED } },
    });
    if (deleted.count === 0) {
      throw new ChauffeurInvitationExistsException();
    }
  }

  async list(fleetOwnerId: string, query: ListChauffeursQueryDto) {
    const where = { fleetOwnerId };
    const [items, total] = await Promise.all([
      this.databaseService.chauffeurVerification.findMany({
        where,
        include: {
          chauffeur: {
            select: {
              id: true,
              image: true,
              chauffeurDisabledAt: true,
            },
          },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.databaseService.chauffeurVerification.count({ where }),
    ]);
    return {
      items: items.map((item) => this.toOwnerRecord(item)),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
      complianceRequirements: COMPLIANCE_REQUIREMENTS,
    };
  }

  async update(fleetOwnerId: string, chauffeurId: string, input: UpdateChauffeurDto) {
    const updated = await this.databaseService.user.updateMany({
      where: {
        id: chauffeurId,
        fleetOwnerId,
        chauffeurApprovalStatus: ChauffeurApprovalStatus.APPROVED,
      },
      data: { chauffeurDisabledAt: input.isActive ? null : new Date() },
    });
    if (updated.count === 0) {
      throw new ChauffeurNotFoundException();
    }
    const chauffeur = await this.databaseService.chauffeurVerification.findFirstOrThrow({
      where: { fleetOwnerId, chauffeurId },
      include: {
        chauffeur: {
          select: { id: true, image: true, chauffeurDisabledAt: true },
        },
      },
    });
    return this.toOwnerRecord(chauffeur);
  }

  async exchangeInvitation(token: string) {
    const invitation = await this.databaseService.chauffeurVerification.findUnique({
      where: { inviteTokenHash: this.hash(token) },
      include: { fleetOwner: { select: { name: true } } },
    });
    if (
      !invitation ||
      invitation.inviteAcceptedAt ||
      invitation.inviteExpiresAt <= new Date() ||
      invitation.status !== ChauffeurVerificationStatus.INVITED
    ) {
      throw new ChauffeurInvitationInvalidException();
    }

    const sessionToken = randomBytes(32).toString("base64url");
    const now = new Date();
    const accepted = await this.databaseService.chauffeurVerification.updateMany({
      where: {
        id: invitation.id,
        inviteAcceptedAt: null,
        inviteExpiresAt: { gt: now },
        status: ChauffeurVerificationStatus.INVITED,
      },
      data: {
        inviteAcceptedAt: now,
        sessionTokenHash: this.hash(sessionToken),
        sessionExpiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      },
    });
    if (accepted.count === 0) {
      throw new ChauffeurInvitationInvalidException();
    }
    const current = await this.getVerification(invitation.id);
    return {
      sessionToken,
      sessionExpiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      onboarding: this.toOnboardingState(current),
    };
  }

  async getOnboarding(verificationId: string) {
    return this.toOnboardingState(await this.getVerification(verificationId));
  }

  async acceptConsent(verificationId: string) {
    const verification = await this.getVerification(verificationId);
    if (
      verification.status === ChauffeurVerificationStatus.APPROVED ||
      (verification.termsAcceptedAt && verification.privacyAcceptedAt)
    ) {
      return this.toOnboardingState(verification);
    }
    const now = new Date();
    await this.databaseService.chauffeurVerification.update({
      where: { id: verificationId },
      data: {
        termsAcceptedAt: verification.termsAcceptedAt ?? now,
        privacyAcceptedAt: verification.privacyAcceptedAt ?? now,
        status: ChauffeurVerificationStatus.CONSENTED,
      },
    });
    return this.getOnboarding(verificationId);
  }

  async sendPhoneVerification(verificationId: string) {
    const verification = await this.getVerification(verificationId);
    if (!verification.termsAcceptedAt || !verification.privacyAcceptedAt) {
      throw new ChauffeurStepIncompleteException("CONSENT");
    }
    if (verification.phoneVerifiedAt) {
      return { status: "VERIFIED", phoneNumber: this.maskPhone(verification.phoneNumber) };
    }
    try {
      return await this.phoneVerificationService.sendCode(
        `chauffeur:${verificationId}`,
        verification.phoneNumber,
      );
    } catch (error) {
      if (error instanceof PhoneVerificationProviderUnavailableException) {
        throw new ChauffeurPhoneProviderUnavailableException();
      }
      throw error;
    }
  }

  async checkPhoneVerification(verificationId: string, code: string) {
    const verification = await this.getVerification(verificationId);
    if (!verification.termsAcceptedAt || !verification.privacyAcceptedAt) {
      throw new ChauffeurStepIncompleteException("CONSENT");
    }
    if (verification.phoneVerifiedAt) {
      return { status: "VERIFIED", phoneNumber: this.maskPhone(verification.phoneNumber) };
    }
    try {
      await this.phoneVerificationService.checkCode(
        `chauffeur:${verificationId}`,
        verification.phoneNumber,
        code,
      );
    } catch (error) {
      if (error instanceof PhoneVerificationCodeInvalidException) {
        throw new ChauffeurPhoneCodeInvalidException();
      }
      if (error instanceof PhoneVerificationProviderUnavailableException) {
        throw new ChauffeurPhoneProviderUnavailableException();
      }
      throw error;
    }
    await this.databaseService.chauffeurVerification.update({
      where: { id: verificationId },
      data: {
        phoneVerifiedAt: new Date(),
        status: ChauffeurVerificationStatus.PHONE_VERIFIED,
      },
    });
    return { status: "VERIFIED", phoneNumber: this.maskPhone(verification.phoneNumber) };
  }

  async verifyNin(verificationId: string, idempotencyKey: string, input: VerifyChauffeurNinDto) {
    const verification = await this.getVerification(verificationId);
    if (verification.status === ChauffeurVerificationStatus.APPROVED) {
      return this.toOnboardingState(verification);
    }
    if (!verification.phoneVerifiedAt) {
      throw new ChauffeurStepIncompleteException("PHONE");
    }
    const claim = await this.claimStage(
      verificationId,
      ChauffeurVerificationStage.IDENTITY,
      idempotencyKey,
      this.hashJson({ nin: input.nin }),
    );
    if (claim.replay) {
      return this.getOnboarding(verificationId);
    }

    try {
      const identity = await this.premblyService.verifyNin(input.nin);
      await this.databaseService.$transaction([
        this.databaseService.chauffeurVerification.update({
          where: { id: verificationId },
          data: {
            ninHash: this.hash(input.nin),
            ninLast4: input.nin.slice(-4),
            identityFirstName: identity.firstName,
            identityMiddleName: identity.middleName,
            identityLastName: identity.lastName,
            identityProviderRef: identity.reference,
            status: ChauffeurVerificationStatus.IDENTITY_VERIFIED,
          },
        }),
        this.databaseService.chauffeurVerificationStageRequest.update({
          where: { id: claim.requestId },
          data: { status: ProviderVerificationStatus.SUCCEEDED },
        }),
      ]);
      return this.getOnboarding(verificationId);
    } catch (error) {
      const mapped = this.mapNinError(error);
      await this.failStage(claim.requestId, mapped.getErrorCode());
      throw mapped;
    }
  }

  async verifyDriving(
    verificationId: string,
    idempotencyKey: string,
    input: VerifyChauffeurDrivingDto,
    selfie: UploadedChauffeurSelfie,
  ) {
    const verification = await this.getVerification(verificationId);
    if (verification.status === ChauffeurVerificationStatus.APPROVED) {
      return this.toOnboardingState(verification);
    }
    if (
      !verification.ninHash ||
      !verification.identityFirstName ||
      !verification.identityLastName
    ) {
      throw new ChauffeurStepIncompleteException("NIN");
    }
    const processedSelfie = await this.imageService.processSelfie(selfie);
    const claim = await this.claimStage(
      verificationId,
      ChauffeurVerificationStage.DRIVING,
      idempotencyKey,
      this.hashJson({
        driversLicenseNumber: input.driversLicenseNumber,
        selfie: this.hash(processedSelfie),
      }),
    );
    if (claim.replay) {
      return this.getOnboarding(verificationId);
    }

    let license: PremblyDriversLicenseResult;
    try {
      license = await this.premblyService.verifyDriversLicense(
        input.driversLicenseNumber,
        verification.identityFirstName,
        verification.identityLastName,
      );
    } catch (error) {
      const mapped = this.mapLicenseError(error);
      await this.failStage(claim.requestId, mapped.getErrorCode());
      throw mapped;
    }

    try {
      this.assertIdentityMatches(verification, license);
      this.assertEligibleAge(license.dateOfBirth);
      if (license.expiresAt < this.startOfTodayUtc()) {
        throw new ChauffeurLicenseExpiredException();
      }
      const selfieBase64 = processedSelfie.toString("base64");
      const liveness = await this.premblyService.verifyFaceLiveness(selfieBase64);
      const faceMatch = await this.premblyService.compareFaces(license.officialPhoto, selfieBase64);
      if (
        liveness.confidence < MINIMUM_LIVENESS_CONFIDENCE ||
        faceMatch.confidence < MINIMUM_FACE_MATCH_CONFIDENCE
      ) {
        throw new ChauffeurBiometricNotVerifiedException();
      }
      const imageKey = `${verification.fleetOwnerId}/chauffeurs/${verification.id}/documents/selfie.jpg`;
      const selfieObjectKey = await this.storageService.uploadBuffer(
        processedSelfie,
        imageKey,
        "image/jpeg",
      );
      try {
        await this.completeDrivingVerification({
          verification,
          requestId: claim.requestId,
          license,
          liveness,
          faceMatch,
          selfieObjectKey,
          licenseNumber: input.driversLicenseNumber,
        });
      } catch (error) {
        await this.storageService.deleteObjectByKey(imageKey).catch(() => undefined);
        throw error;
      }
      return this.getOnboarding(verificationId);
    } catch (error) {
      const mapped = this.mapDrivingError(error);
      await this.failStage(claim.requestId, mapped.getErrorCode());
      throw mapped;
    }
  }

  private async completeDrivingVerification({
    verification,
    requestId,
    license,
    liveness,
    faceMatch,
    selfieObjectKey,
    licenseNumber,
  }: {
    verification: Awaited<ReturnType<ChauffeurService["getVerification"]>>;
    requestId: string;
    license: Awaited<ReturnType<PremblyService["verifyDriversLicense"]>>;
    liveness: Awaited<ReturnType<PremblyService["verifyFaceLiveness"]>>;
    faceMatch: Awaited<ReturnType<PremblyService["compareFaces"]>>;
    selfieObjectKey: string;
    licenseNumber: string;
  }): Promise<void> {
    await this.databaseService.$transaction(async (tx) => {
      const found = await tx.user.findFirst({
        where: { email: { equals: verification.email, mode: "insensitive" } },
        select: { id: true },
      });
      const existing =
        found && (await lockUserRow(tx, found.id))
          ? await tx.user.findUnique({
              where: { id: found.id },
              select: {
                id: true,
                fleetOwnerId: true,
                isOwnerDriver: true,
                roles: { select: { name: true } },
              },
            })
          : null;
      if (
        existing &&
        (existing.id === verification.fleetOwnerId ||
          existing.isOwnerDriver ||
          (existing.fleetOwnerId && existing.fleetOwnerId !== verification.fleetOwnerId) ||
          existing.roles.some(({ name }) => name !== USER))
      ) {
        throw new ChauffeurAccountConflictException();
      }

      const legalName = [
        verification.identityFirstName,
        verification.identityMiddleName,
        verification.identityLastName,
      ]
        .filter(Boolean)
        .join(" ");
      const chauffeur = existing
        ? await tx.user.update({
            where: { id: existing.id },
            data: {
              name: legalName,
              phoneNumber: verification.phoneNumber,
              emailVerified: true,
              phoneVerifiedAt: verification.phoneVerifiedAt,
              termsAcceptedAt: verification.termsAcceptedAt,
              privacyAcceptedAt: verification.privacyAcceptedAt,
              fleetOwnerId: verification.fleetOwnerId,
              chauffeurApprovalStatus: ChauffeurApprovalStatus.APPROVED,
              chauffeurDisabledAt: null,
              hasOnboarded: true,
              roles: { connect: { name: USER } },
            },
            select: { id: true },
          })
        : await tx.user.create({
            data: {
              name: legalName,
              email: verification.email,
              phoneNumber: verification.phoneNumber,
              emailVerified: true,
              phoneVerifiedAt: verification.phoneVerifiedAt,
              termsAcceptedAt: verification.termsAcceptedAt,
              privacyAcceptedAt: verification.privacyAcceptedAt,
              fleetOwnerId: verification.fleetOwnerId,
              chauffeurApprovalStatus: ChauffeurApprovalStatus.APPROVED,
              hasOnboarded: true,
              roles: { connect: { name: USER } },
            },
            select: { id: true },
          });

      await tx.chauffeurVerification.update({
        where: { id: verification.id },
        data: {
          chauffeurId: chauffeur.id,
          driversLicenseHash: this.hash(licenseNumber),
          driversLicenseLast4: licenseNumber.slice(-4).toUpperCase(),
          driversLicenseExpiresAt: license.expiresAt,
          driversLicenseProviderRef: license.reference,
          dateOfBirth: license.dateOfBirth,
          livenessProviderRef: liveness.reference,
          livenessConfidence: liveness.confidence,
          faceMatchConfidence: faceMatch.confidence,
          selfieObjectKey,
          status: ChauffeurVerificationStatus.APPROVED,
        },
      });
      await tx.chauffeurVerificationStageRequest.update({
        where: { id: requestId },
        data: { status: ProviderVerificationStatus.SUCCEEDED },
      });

      this.logger.info(
        { fleetOwnerId: verification.fleetOwnerId, chauffeurId: chauffeur.id },
        "Approved chauffeur after automated verification",
      );
    });
  }

  private async claimStage(
    verificationId: string,
    stage: ChauffeurVerificationStage,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<StageClaim> {
    const keyHash = this.hash(idempotencyKey);
    const existing = await this.databaseService.chauffeurVerificationStageRequest.findUnique({
      where: {
        verificationId_idempotencyKey: {
          verificationId,
          idempotencyKey: keyHash,
        },
      },
    });
    if (existing) {
      if (existing.stage !== stage || existing.requestHash !== requestHash) {
        throw new ChauffeurIdempotencyKeyReusedException();
      }
      if (existing.status === ProviderVerificationStatus.SUCCEEDED) {
        return { requestId: existing.id, replay: true };
      }
      if (existing.status === ProviderVerificationStatus.FAILED) {
        throw this.storedStageFailure(existing.failureReason);
      }
      if (existing.processingExpiresAt > new Date()) {
        throw new ChauffeurRequestInProgressException();
      }
      const reclaimed = await this.databaseService.chauffeurVerificationStageRequest.updateMany({
        where: {
          id: existing.id,
          status: ProviderVerificationStatus.PROCESSING,
          processingExpiresAt: { lte: new Date() },
        },
        data: { processingExpiresAt: new Date(Date.now() + PROCESSING_LEASE_MS) },
      });
      if (reclaimed.count === 0) {
        throw new ChauffeurRequestInProgressException();
      }
      return { requestId: existing.id, replay: false };
    }

    try {
      const created = await this.databaseService.chauffeurVerificationStageRequest.create({
        data: {
          verificationId,
          stage,
          idempotencyKey: keyHash,
          requestHash,
          processingExpiresAt: new Date(Date.now() + PROCESSING_LEASE_MS),
        },
      });
      return { requestId: created.id, replay: false };
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ChauffeurRequestInProgressException();
      }
      throw error;
    }
  }

  private failStage(requestId: string, failureReason: string): Promise<unknown> {
    return this.databaseService.chauffeurVerificationStageRequest.updateMany({
      where: { id: requestId, status: ProviderVerificationStatus.PROCESSING },
      data: { status: ProviderVerificationStatus.FAILED, failureReason },
    });
  }

  private storedStageFailure(failureReason: string | null): ChauffeurException {
    switch (failureReason) {
      case ChauffeurErrorCode.NIN_NOT_VERIFIED:
        return new ChauffeurNinNotVerifiedException();
      case ChauffeurErrorCode.LICENSE_NOT_VERIFIED:
        return new ChauffeurLicenseNotVerifiedException();
      case ChauffeurErrorCode.LICENSE_EXPIRED:
        return new ChauffeurLicenseExpiredException();
      case ChauffeurErrorCode.MINIMUM_AGE_NOT_MET:
        return new ChauffeurMinimumAgeException();
      case ChauffeurErrorCode.IDENTITY_MISMATCH:
        return new ChauffeurIdentityMismatchException();
      case ChauffeurErrorCode.BIOMETRIC_NOT_VERIFIED:
        return new ChauffeurBiometricNotVerifiedException();
      case ChauffeurErrorCode.ACCOUNT_CONFLICT:
        return new ChauffeurAccountConflictException();
      case ChauffeurErrorCode.OPERATION_FAILED:
        return new ChauffeurOperationFailedException();
      default:
        return new ChauffeurProviderUnavailableException();
    }
  }

  private mapNinError(error: unknown): ChauffeurException {
    if (error instanceof PremblyError && error.kind === "REJECTED") {
      return new ChauffeurNinNotVerifiedException();
    }
    return new ChauffeurProviderUnavailableException();
  }

  private mapLicenseError(error: unknown): ChauffeurException {
    if (error instanceof PremblyError && error.kind === "REJECTED") {
      return new ChauffeurLicenseNotVerifiedException();
    }
    return new ChauffeurProviderUnavailableException();
  }

  private mapDrivingError(error: unknown): ChauffeurException {
    if (error instanceof ChauffeurException) {
      return error;
    }
    if (error instanceof PremblyError && error.kind === "REJECTED") {
      return new ChauffeurBiometricNotVerifiedException();
    }
    if (error instanceof PremblyError) {
      return new ChauffeurProviderUnavailableException();
    }
    if (isUniqueConstraintError(error)) {
      return new ChauffeurAccountConflictException();
    }
    this.logger.error({ err: toLogError(error) }, "Failed to complete chauffeur verification");
    return new ChauffeurOperationFailedException();
  }

  private assertIdentityMatches(
    verification: Awaited<ReturnType<ChauffeurService["getVerification"]>>,
    license: Awaited<ReturnType<PremblyService["verifyDriversLicense"]>>,
  ): void {
    if (
      this.normalizeName(verification.identityFirstName ?? "") !==
        this.normalizeName(license.firstName) ||
      this.normalizeName(verification.identityLastName ?? "") !==
        this.normalizeName(license.lastName)
    ) {
      throw new ChauffeurIdentityMismatchException();
    }
  }

  private assertEligibleAge(dateOfBirth: Date): void {
    const today = new Date();
    const cutoff = new Date(
      Date.UTC(
        today.getUTCFullYear() - MINIMUM_CHAUFFEUR_AGE,
        today.getUTCMonth(),
        today.getUTCDate(),
      ),
    );
    if (dateOfBirth > cutoff) {
      throw new ChauffeurMinimumAgeException();
    }
  }

  private startOfTodayUtc(): Date {
    const today = new Date();
    return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  }

  private getVerification(verificationId: string) {
    return this.databaseService.chauffeurVerification.findUniqueOrThrow({
      where: { id: verificationId },
      include: { fleetOwner: { select: { name: true } } },
    });
  }

  private toOnboardingState(
    verification: Awaited<ReturnType<ChauffeurService["getVerification"]>>,
  ) {
    return {
      id: verification.id,
      name: verification.name,
      email: verification.email,
      phoneNumber: this.maskPhone(verification.phoneNumber),
      fleetOwnerName: verification.fleetOwner.name,
      status: verification.status,
      steps: {
        consent: verification.termsAcceptedAt !== null && verification.privacyAcceptedAt !== null,
        phone: verification.phoneVerifiedAt !== null,
        nin: verification.identityProviderRef !== null,
        driving: verification.status === ChauffeurVerificationStatus.APPROVED,
      },
      complianceRequirements: COMPLIANCE_REQUIREMENTS,
    };
  }

  private toOwnerRecord<
    T extends {
      id: string;
      chauffeurId: string | null;
      name: string;
      email: string;
      phoneNumber: string;
      status: ChauffeurVerificationStatus;
      createdAt: Date;
      chauffeur?: { image: string | null; chauffeurDisabledAt: Date | null } | null;
    },
  >(verification: T) {
    return {
      id: verification.id,
      chauffeurId: verification.chauffeurId,
      name: verification.name,
      email: verification.email,
      phoneNumber: verification.phoneNumber,
      status: verification.status,
      isActive:
        verification.status === ChauffeurVerificationStatus.APPROVED &&
        verification.chauffeur?.chauffeurDisabledAt === null,
      image: verification.chauffeur?.image ?? null,
      invitedAt: verification.createdAt,
    };
  }

  private hash(value: string | Buffer): string {
    return createHmac("sha256", this.hashKey).update(value).digest("hex");
  }

  private hashJson(value: unknown): string {
    return this.hash(JSON.stringify(value));
  }

  private normalizeName(value: string): string {
    return value
      .normalize("NFKD")
      .replaceAll(/[^A-Za-z0-9]/g, "")
      .toUpperCase();
  }

  private maskPhone(phoneNumber: string): string {
    return `${"*".repeat(Math.max(0, phoneNumber.length - 4))}${phoneNumber.slice(-4)}`;
  }
}
