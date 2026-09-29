import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ChauffeurApprovalStatus,
  type ChauffeurVerification,
  ChauffeurVerificationStage,
  ChauffeurVerificationStatus,
  ProviderVerificationStatus,
  VerificationDecisionStatus,
} from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { toLogError } from "../../common/logging/error-logging.helper";
import type { EnvConfig } from "../../config/env.config";
import { getEmailPublicEnv } from "../../email-public-env";
import { normalizeDriversLicenseNumber } from "../../shared/drivers-license-number";
import { maskEmail } from "../../shared/helper";
import { renderChauffeurInvitationEmail } from "../../templates/emails";
import { DatabaseService, isUniqueConstraintError } from "../database/database.service";
import { DriversLicenseLookupService } from "../drivers-license/drivers-license-lookup.service";
import { EmailService } from "../email/email.service";
import { InterventionService } from "../intervention/intervention.service";
import type { MonoDriversLicenseResult } from "../mono/mono.interface";
import { MonoError } from "../mono/mono.service";
import { NinLookupService } from "../nin/nin-lookup.service";
import { PremblyError } from "../prembly/prembly.service";
import { StorageService } from "../storage/storage.service";
import {
  PhoneVerificationCodeInvalidException,
  PhoneVerificationProviderUnavailableException,
} from "../verification/account-verification.error";
import { PhoneVerificationService } from "../verification/phone-verification.service";
import { InvalidSelfieImageError, SelfieImageService } from "../verification/selfie-image.service";
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
  ChauffeurInvalidSelfieException,
  ChauffeurInvitationExistsException,
  ChauffeurInvitationInvalidException,
  ChauffeurInvitationNotAllowedException,
  ChauffeurInvitedNameMismatchException,
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
import { meetsMinimumChauffeurAge } from "./chauffeur-age";

const INVITE_TTL_MS = 48 * 60 * 60 * 1000;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const PROCESSING_LEASE_MS = 2 * 60 * 1000;

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
    private readonly ninLookupService: NinLookupService,
    private readonly driversLicenseLookupService: DriversLicenseLookupService,
    private readonly imageService: SelfieImageService,
    private readonly storageService: StorageService,
    private readonly interventionService: InterventionService,
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
          name: `${input.firstName} ${input.lastName}`,
          firstName: input.firstName,
          lastName: input.lastName,
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

    if (!this.canReinvite(existing)) {
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
      const identity = await this.ninLookupService.lookup(input.nin);
      this.assertInvitedNameMatches(verification, identity);
      await this.databaseService.$transaction([
        this.databaseService.chauffeurVerification.update({
          where: { id: verificationId },
          data: {
            ninHash: this.hash(input.nin),
            ninLast4: input.nin.slice(-4),
            identityFirstName: identity.firstName,
            identityMiddleName: identity.middleName,
            identityLastName: identity.lastName,
            identityOfficialPhoto: identity.officialPhoto,
            identityProviderRef: identity.reference,
            dateOfBirth: identity.dateOfBirth,
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
    await this.assertDrivingCanStart(verification);
    if (
      !verification.ninHash ||
      !verification.identityFirstName ||
      !verification.identityLastName ||
      !verification.dateOfBirth
    ) {
      throw new ChauffeurStepIncompleteException("NIN");
    }
    this.assertEligibleAge(verification.dateOfBirth);
    const processedSelfie = await this.processSelfie(selfie);
    const driversLicenseNumber = normalizeDriversLicenseNumber(input.driversLicenseNumber);
    const driversLicenseHash = this.hash(driversLicenseNumber);
    const licenseAlreadySubmitted = verification.driversLicenseHash === driversLicenseHash;
    if (verification.driversLicenseHash && !licenseAlreadySubmitted) {
      throw new ChauffeurLicenseNotVerifiedException();
    }
    const claim = await this.claimStage(
      verificationId,
      ChauffeurVerificationStage.DRIVING,
      idempotencyKey,
      this.hashJson({
        driversLicenseNumber,
        selfie: this.hash(processedSelfie),
      }),
    );
    if (claim.replay) {
      return this.getOnboarding(verificationId);
    }

    let license: MonoDriversLicenseResult | null = null;
    let licenseOutage = false;
    if (!licenseAlreadySubmitted) {
      try {
        license = await this.driversLicenseLookupService.lookup(
          driversLicenseNumber,
          verification.identityFirstName,
          verification.identityLastName,
          verification.dateOfBirth,
        );
      } catch (error) {
        if (
          (error instanceof MonoError || error instanceof PremblyError) &&
          ["UNAVAILABLE", "INVALID_RESPONSE"].includes(error.kind)
        ) {
          licenseOutage = true;
        } else {
          const mapped = this.mapLicenseError(error);
          await this.failStage(claim.requestId, mapped.getErrorCode());
          throw mapped;
        }
      }
    }

    try {
      if (license) {
        this.assertIdentityMatches(verification, license);
        this.assertEligibleAge(license.dateOfBirth);
        if (license.expiresAt < this.startOfTodayUtc()) {
          throw new ChauffeurLicenseExpiredException();
        }
      }
      const ninPhoto = verification.identityOfficialPhoto;
      if (!ninPhoto || !verification.privacyAcceptedAt) {
        throw new ChauffeurBiometricNotVerifiedException();
      }
      const imageKey = `fleet-owners/${verification.fleetOwnerId}/chauffeurs/${verification.id}/documents/${randomUUID()}.webp`;
      const { key: selfieObjectKey } = await this.storageService.uploadBuffer(
        processedSelfie,
        imageKey,
        "image/jpeg",
      );
      const interventionIds = await this.reserveDrivingSubmission({
        verificationId: verification.id,
        selfieObjectKey,
        driversLicenseNumber,
        license,
        licenseOutage,
        licenseAlreadySubmitted,
      });
      for (const interventionId of interventionIds) {
        await this.interventionService.dispatchIntervention(interventionId);
      }
      return this.getOnboarding(verificationId);
    } catch (error) {
      const mapped = this.mapDrivingError(error);
      await this.failStage(claim.requestId, mapped.getErrorCode());
      throw mapped;
    }
  }

  async replaceSelfie(
    verificationId: string,
    idempotencyKey: string,
    selfie: UploadedChauffeurSelfie,
  ) {
    const verification = await this.getVerification(verificationId);
    const processedSelfie = await this.processSelfie(selfie);
    const requestHash = this.hashJson({ selfieRetake: this.hash(processedSelfie) });
    const existing = await this.databaseService.chauffeurVerificationStageRequest.findUnique({
      where: {
        verificationId_idempotencyKey: {
          verificationId,
          idempotencyKey: this.hash(idempotencyKey),
        },
      },
    });
    if (
      existing &&
      (existing.stage !== ChauffeurVerificationStage.DRIVING ||
        existing.requestHash !== requestHash)
    ) {
      throw new ChauffeurIdempotencyKeyReusedException();
    }
    if (existing?.status === ProviderVerificationStatus.SUCCEEDED) {
      return this.getOnboarding(verificationId);
    }
    if (
      verification.status === ChauffeurVerificationStatus.APPROVED ||
      !verification.selfieRetakeRequired ||
      !verification.driversLicenseHash ||
      verification.faceDecision !== VerificationDecisionStatus.PENDING
    ) {
      throw new ChauffeurRequestInProgressException();
    }
    const claim = await this.claimStage(
      verificationId,
      ChauffeurVerificationStage.DRIVING,
      idempotencyKey,
      requestHash,
    );
    if (claim.replay) return this.getOnboarding(verificationId);

    const imageKey = `fleet-owners/${verification.fleetOwnerId}/chauffeurs/${verification.id}/documents/${randomUUID()}.webp`;
    let selfieObjectKey: string | null = null;
    try {
      selfieObjectKey = (
        await this.storageService.uploadBuffer(processedSelfie, imageKey, "image/jpeg")
      ).key;
      const interventionId = await this.databaseService.$transaction(async (tx) => {
        const updated = await tx.chauffeurVerification.updateMany({
          where: {
            id: verification.id,
            selfieObjectKey: null,
            selfieRetakeRequired: true,
            faceDecision: VerificationDecisionStatus.PENDING,
          },
          data: { selfieObjectKey, selfieRetakeRequired: false },
        });
        if (updated.count === 0) throw new ChauffeurRequestInProgressException();
        const intervention = await this.interventionService.bindChauffeurFace(tx, verification.id);
        if (!intervention) throw new ChauffeurRequestInProgressException();
        return intervention.id;
      });
      await this.interventionService.dispatchIntervention(interventionId);
      return this.getOnboarding(verificationId);
    } catch (error) {
      if (selfieObjectKey) {
        await this.storageService.deleteObjectByKey(selfieObjectKey).catch(() => undefined);
      }
      const mapped = this.mapDrivingError(error);
      await this.failStage(claim.requestId, mapped.getErrorCode());
      throw mapped;
    }
  }

  private async assertDrivingCanStart(
    verification: Awaited<ReturnType<ChauffeurService["getVerification"]>>,
  ): Promise<void> {
    if (
      verification.driversLicenseDecision === VerificationDecisionStatus.REJECTED ||
      verification.faceDecision === VerificationDecisionStatus.REJECTED
    ) {
      const terminalFailure =
        await this.databaseService.chauffeurVerificationStageRequest.findFirst({
          where: {
            verificationId: verification.id,
            stage: ChauffeurVerificationStage.DRIVING,
            status: ProviderVerificationStatus.FAILED,
            failureReason: {
              in: [
                ChauffeurErrorCode.ACCOUNT_CONFLICT,
                ChauffeurErrorCode.MINIMUM_AGE_NOT_MET,
                ChauffeurErrorCode.OPERATION_FAILED,
              ],
            },
          },
          orderBy: { createdAt: "desc" },
          select: { failureReason: true },
        });
      if (terminalFailure?.failureReason) {
        throw this.storedStageFailure(terminalFailure.failureReason);
      }
    }
    if (verification.driversLicenseDecision === VerificationDecisionStatus.REJECTED) {
      throw new ChauffeurLicenseNotVerifiedException();
    }
    if (verification.faceDecision === VerificationDecisionStatus.REJECTED) {
      throw new ChauffeurBiometricNotVerifiedException();
    }
    if (verification.selfieObjectKey) throw new ChauffeurRequestInProgressException();
  }

  private async reserveDrivingSubmission(input: {
    verificationId: string;
    selfieObjectKey: string;
    driversLicenseNumber: string;
    license: MonoDriversLicenseResult | null;
    licenseOutage: boolean;
    licenseAlreadySubmitted: boolean;
  }): Promise<string[]> {
    try {
      return await this.databaseService.$transaction(async (tx) => {
        const updated = await tx.chauffeurVerification.updateMany({
          where: {
            id: input.verificationId,
            selfieObjectKey: null,
            faceDecision: VerificationDecisionStatus.PENDING,
          },
          data: {
            selfieObjectKey: input.selfieObjectKey,
            selfieRetakeRequired: false,
            ...(input.licenseAlreadySubmitted
              ? {}
              : {
                  driversLicenseHash: this.hash(input.driversLicenseNumber),
                  driversLicenseLast4: input.driversLicenseNumber.slice(-4).toUpperCase(),
                  driversLicenseExpiresAt: input.license?.expiresAt,
                  driversLicenseProviderRef: input.license?.reference,
                  driversLicenseDecision: input.license
                    ? VerificationDecisionStatus.APPROVED
                    : VerificationDecisionStatus.PENDING,
                }),
          },
        });
        if (updated.count === 0) throw new ChauffeurRequestInProgressException();
        const interventionIds: string[] = [];
        if (input.licenseOutage) {
          const licenseIntervention = await this.interventionService.bindChauffeurLicense(
            tx,
            input.verificationId,
            input.driversLicenseNumber,
          );
          if (!licenseIntervention) throw new ChauffeurRequestInProgressException();
          interventionIds.push(licenseIntervention.id);
        }
        const faceIntervention = await this.interventionService.bindChauffeurFace(
          tx,
          input.verificationId,
        );
        if (!faceIntervention) throw new ChauffeurRequestInProgressException();
        interventionIds.push(faceIntervention.id);
        return interventionIds;
      });
    } catch (error) {
      await this.storageService.deleteObjectByKey(input.selfieObjectKey).catch(() => undefined);
      throw error;
    }
  }

  private async processSelfie(selfie: UploadedChauffeurSelfie): Promise<Buffer> {
    try {
      return await this.imageService.process(selfie);
    } catch (error) {
      if (error instanceof InvalidSelfieImageError) throw new ChauffeurInvalidSelfieException();
      throw error;
    }
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
      case ChauffeurErrorCode.INVITED_NAME_MISMATCH:
        return new ChauffeurInvitedNameMismatchException();
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
    if (error instanceof ChauffeurException) return error;
    if (
      (error instanceof MonoError || error instanceof PremblyError) &&
      error.kind === "REJECTED"
    ) {
      return new ChauffeurNinNotVerifiedException();
    }
    return new ChauffeurProviderUnavailableException();
  }

  private mapLicenseError(error: unknown): ChauffeurException {
    if (
      (error instanceof MonoError || error instanceof PremblyError) &&
      error.kind === "REJECTED"
    ) {
      return new ChauffeurLicenseNotVerifiedException();
    }
    return new ChauffeurProviderUnavailableException();
  }

  private mapDrivingError(error: unknown): ChauffeurException {
    if (error instanceof ChauffeurException) {
      return error;
    }
    if (isUniqueConstraintError(error)) {
      return new ChauffeurAccountConflictException();
    }
    this.logger.error({ err: toLogError(error) }, "Failed to complete chauffeur verification");
    return new ChauffeurOperationFailedException();
  }

  private assertInvitedNameMatches(
    verification: { firstName: string; lastName: string },
    identity: { firstName: string; lastName: string },
  ): void {
    const invitedFirstName = this.normalizeName(verification.firstName);
    const identityFirstName = this.normalizeName(identity.firstName);
    const invitedLastName = this.normalizeName(verification.lastName);
    const identityLastName = this.normalizeName(identity.lastName);
    if (
      !invitedFirstName ||
      !identityFirstName ||
      !invitedLastName ||
      !identityLastName ||
      invitedFirstName !== identityFirstName ||
      invitedLastName !== identityLastName
    ) {
      throw new ChauffeurInvitedNameMismatchException();
    }
  }

  private assertIdentityMatches(
    verification: Awaited<ReturnType<ChauffeurService["getVerification"]>>,
    license: MonoDriversLicenseResult,
  ): void {
    if (
      this.normalizeName(verification.identityFirstName ?? "") !==
        this.normalizeName(license.firstName) ||
      this.normalizeName(verification.identityLastName ?? "") !==
        this.normalizeName(license.lastName) ||
      verification.dateOfBirth?.toISOString().slice(0, 10) !==
        license.dateOfBirth.toISOString().slice(0, 10)
    ) {
      throw new ChauffeurIdentityMismatchException();
    }
  }

  private assertEligibleAge(dateOfBirth: Date): void {
    if (!meetsMinimumChauffeurAge(dateOfBirth)) {
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
        nin: verification.identityProviderRef !== null && verification.dateOfBirth !== null,
        driving: verification.status === ChauffeurVerificationStatus.APPROVED,
        drivingSubmitted: verification.selfieObjectKey !== null,
        rejected:
          verification.faceDecision === VerificationDecisionStatus.REJECTED ||
          verification.driversLicenseDecision === VerificationDecisionStatus.REJECTED,
        selfieRetakeRequired: verification.selfieRetakeRequired,
      },
      complianceRequirements: COMPLIANCE_REQUIREMENTS,
    };
  }

  private canReinvite(verification: {
    status: ChauffeurVerificationStatus;
    inviteAcceptedAt: Date | null;
    inviteExpiresAt: Date;
    sessionExpiresAt: Date | null;
  }): boolean {
    const now = new Date();
    return (
      verification.status !== ChauffeurVerificationStatus.APPROVED &&
      ((!verification.inviteAcceptedAt && verification.inviteExpiresAt <= now) ||
        (verification.inviteAcceptedAt !== null &&
          (verification.sessionExpiresAt === null || verification.sessionExpiresAt <= now)))
    );
  }

  private toOwnerRecord<
    T extends {
      id: string;
      chauffeurId: string | null;
      name: string;
      firstName: string;
      lastName: string;
      email: string;
      phoneNumber: string;
      status: ChauffeurVerificationStatus;
      createdAt: Date;
      inviteAcceptedAt: Date | null;
      inviteExpiresAt: Date;
      sessionExpiresAt: Date | null;
      chauffeur?: { image: string | null; chauffeurDisabledAt: Date | null } | null;
    },
  >(verification: T) {
    return {
      id: verification.id,
      chauffeurId: verification.chauffeurId,
      name: verification.name,
      firstName: verification.firstName,
      lastName: verification.lastName,
      email: verification.email,
      phoneNumber: verification.phoneNumber,
      status: verification.status,
      isActive:
        verification.status === ChauffeurVerificationStatus.APPROVED &&
        verification.chauffeur?.chauffeurDisabledAt === null,
      image: verification.chauffeur?.image ?? null,
      invitedAt: verification.createdAt,
      canReinvite: this.canReinvite(verification),
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
