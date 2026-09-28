import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import {
  AccountVerificationStatus,
  ChauffeurVerificationStage,
  ChauffeurVerificationStatus,
  DocumentStatus,
  FleetOwnerStatus,
  NameMatchStatus,
  Prisma,
  ProviderVerificationStatus,
  VerificationDecisionStatus,
  VerificationInterventionKind,
  VerificationInterventionStatus,
} from "@prisma/client";
import type { Queue } from "bullmq";
import { PinoLogger } from "nestjs-pino";
import {
  VERIFICATION_INTERVENTION_QUEUE,
  VERIFICATION_INTERVENTION_RETRY_JOB,
} from "../../config/constants";
import type { EnvConfig } from "../../config/env.config";
import { getEmailPublicEnv } from "../../email-public-env";
import { DatabaseService } from "../database/database.service";
import { DriversLicenseLookupService } from "../drivers-license/drivers-license-lookup.service";
import { EmailService } from "../email/email.service";
import type { MonoDriversLicenseResult } from "../mono/mono.interface";
import { MonoError } from "../mono/mono.service";
import { PremblyError } from "../prembly/prembly.service";
import { SmileIdError, SmileIdService } from "../smile-id/smile-id.service";
import { StorageService } from "../storage/storage.service";
import { ChauffeurActivationService } from "./chauffeur-activation.service";
import type { ApproveInterventionDto, ListInterventionsDto } from "./intervention.dto";
import {
  InterventionAlreadyResolvedException,
  InterventionEvidenceRequiredException,
  InterventionNotFoundException,
} from "./intervention.error";

const RETRY_DELAYS_MS = [15 * 60 * 1000, 30 * 60 * 1000] as const;
type RetryJob = { interventionId: string; attempt: number; openedAt: number };
type DetailedIntervention = Prisma.VerificationInterventionGetPayload<{
  include: { chauffeurVerification: true; accountVerification: true };
}>;
type LicenseRetryEvidence = {
  licenseNumber: string;
  identity: {
    identityFirstName: string;
    identityLastName: string;
    dateOfBirth: Date;
  };
};
type LicenseRetryEvidenceResult =
  | { kind: "VALID"; evidence: LicenseRetryEvidence }
  | { kind: "UNREADABLE_PAYLOAD" }
  | { kind: "INVALID_IDENTITY" };
type TransactionClient = Prisma.TransactionClient;

@Injectable()
export class InterventionService {
  private readonly encryptionKey: Buffer;
  private readonly operationsEmail: string;

  constructor(
    configService: ConfigService<EnvConfig, true>,
    private readonly databaseService: DatabaseService,
    private readonly driversLicenseLookupService: DriversLicenseLookupService,
    private readonly smileIdService: SmileIdService,
    private readonly emailService: EmailService,
    private readonly storageService: StorageService,
    private readonly chauffeurActivationService: ChauffeurActivationService,
    @InjectQueue(VERIFICATION_INTERVENTION_QUEUE)
    private readonly queue: Queue<RetryJob>,
    private readonly logger: PinoLogger,
  ) {
    this.encryptionKey = Buffer.from(
      configService.get("VERIFICATION_INTERVENTION_ENCRYPTION_KEY", {
        infer: true,
      }) as string,
      "base64",
    );
    this.operationsEmail = configService.get("OPERATIONS_EMAIL", { infer: true }) ?? "";
    this.logger.setContext(InterventionService.name);
  }

  bindChauffeurLicense(tx: TransactionClient, verificationId: string, licenseNumber: string) {
    return this.bindLicenseIntervention(tx, {
      resourceKey: `chauffeur-license:${verificationId}`,
      kind: VerificationInterventionKind.CHAUFFEUR_DRIVERS_LICENSE,
      chauffeurVerificationId: verificationId,
      licenseNumber,
    });
  }

  bindOwnerLicense(
    tx: TransactionClient,
    verificationId: string,
    documentApprovalId: string,
    licenseNumber: string,
  ) {
    return this.bindLicenseIntervention(tx, {
      resourceKey: `owner-license:${verificationId}`,
      kind: VerificationInterventionKind.OWNER_DRIVER_LICENSE,
      accountVerificationId: verificationId,
      documentApprovalId,
      licenseNumber,
    });
  }

  async openChauffeurFace(verificationId: string) {
    const intervention = await this.databaseService.$transaction(async (tx) => {
      await this.lockChauffeurVerification(tx, verificationId);
      const verification = await tx.chauffeurVerification.findUnique({
        where: { id: verificationId },
        select: { status: true, faceDecision: true },
      });
      if (
        !verification ||
        verification.status === ChauffeurVerificationStatus.APPROVED ||
        verification.faceDecision !== VerificationDecisionStatus.PENDING
      ) {
        return null;
      }
      const existing = await tx.verificationIntervention.findUnique({
        where: { resourceKey: `chauffeur-face:${verificationId}` },
      });
      if (existing?.status === VerificationInterventionStatus.OPEN) return existing;
      const openedAt = new Date();
      return tx.verificationIntervention.upsert({
        where: { resourceKey: `chauffeur-face:${verificationId}` },
        create: {
          resourceKey: `chauffeur-face:${verificationId}`,
          kind: VerificationInterventionKind.CHAUFFEUR_FACE,
          chauffeurVerificationId: verificationId,
        },
        update: {
          status: VerificationInterventionStatus.OPEN,
          retryAttempt: 0,
          lastAttemptAt: null,
          emailNotifiedAt: null,
          resolutionSource: null,
          resolutionNotes: null,
          resolvedAt: null,
          resolvedById: null,
          createdAt: openedAt,
        },
      });
    });
    if (intervention) await this.dispatchIntervention(intervention.id);
    return intervention;
  }

  private async bindLicenseIntervention(
    tx: TransactionClient,
    data: {
      resourceKey: string;
      kind: VerificationInterventionKind;
      chauffeurVerificationId?: string;
      accountVerificationId?: string;
      documentApprovalId?: string;
      licenseNumber: string;
    },
  ) {
    const existing = await tx.verificationIntervention.findUnique({
      where: { resourceKey: data.resourceKey },
    });
    if (existing?.status === VerificationInterventionStatus.OPEN) return null;
    const encryptedPayload = this.encrypt(data.licenseNumber);
    const openedAt = new Date();
    return tx.verificationIntervention.upsert({
      where: { resourceKey: data.resourceKey },
      create: {
        resourceKey: data.resourceKey,
        kind: data.kind,
        chauffeurVerificationId: data.chauffeurVerificationId,
        accountVerificationId: data.accountVerificationId,
        documentApprovalId: data.documentApprovalId,
        encryptedPayload,
      },
      update: {
        kind: data.kind,
        status: VerificationInterventionStatus.OPEN,
        chauffeurVerificationId: data.chauffeurVerificationId,
        accountVerificationId: data.accountVerificationId,
        documentApprovalId: data.documentApprovalId,
        encryptedPayload,
        retryAttempt: 0,
        lastAttemptAt: null,
        emailNotifiedAt: null,
        resolutionSource: null,
        resolutionNotes: null,
        resolvedAt: null,
        resolvedById: null,
        createdAt: openedAt,
      },
    });
  }

  async dispatchIntervention(interventionId: string): Promise<void> {
    try {
      const intervention = await this.databaseService.verificationIntervention.findUnique({
        where: { id: interventionId },
      });
      if (!intervention || intervention.status !== VerificationInterventionStatus.OPEN) return;
      await Promise.all([
        this.scheduleRetries(intervention).catch(() => {
          this.logger.error(
            { interventionId: intervention.id, kind: intervention.kind },
            "Failed to schedule intervention retries",
          );
        }),
        this.notifyOperations(intervention),
      ]);
    } catch {
      this.logger.error(
        { interventionId },
        "Failed to dispatch verification intervention after commit",
      );
    }
  }

  cancelPreparedIntervention(
    tx: TransactionClient,
    interventionId: string,
    resolutionSource: string,
  ) {
    return tx.verificationIntervention.updateMany({
      where: { id: interventionId, status: VerificationInterventionStatus.OPEN },
      data: {
        status: VerificationInterventionStatus.REJECTED,
        encryptedPayload: null,
        resolvedAt: new Date(),
        resolutionSource,
      },
    });
  }

  private lockChauffeurVerification(tx: TransactionClient, verificationId: string) {
    return tx.$queryRaw(
      Prisma.sql`SELECT id FROM "ChauffeurVerification" WHERE id = ${verificationId}::uuid FOR UPDATE`,
    );
  }

  private async scheduleRetries(intervention: {
    id: string;
    createdAt: Date;
    retryAttempt: number;
  }): Promise<void> {
    await Promise.all(
      RETRY_DELAYS_MS.map((elapsedDelay, index) => {
        const attempt = index + 1;
        if (intervention.retryAttempt >= attempt) return Promise.resolve();
        const jobId = `verification-intervention-${intervention.id}-${intervention.createdAt.getTime()}-${attempt}`;
        return (async () => {
          const existing = await this.queue.getJob?.(jobId);
          if (existing) {
            if ((await existing.getState()) === "failed") await existing.retry("failed");
            return existing;
          }
          const delay = Math.max(intervention.createdAt.getTime() + elapsedDelay - Date.now(), 0);
          return this.queue.add(
            VERIFICATION_INTERVENTION_RETRY_JOB,
            {
              interventionId: intervention.id,
              attempt,
              openedAt: intervention.createdAt.getTime(),
            },
            {
              delay,
              jobId,
              attempts: 3,
              backoff: { type: "exponential", delay: 30_000 },
            },
          );
        })();
      }),
    );
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async repairOpenInterventionDispatch(): Promise<void> {
    const interventions = await this.databaseService.verificationIntervention.findMany({
      where: {
        status: VerificationInterventionStatus.OPEN,
        OR: [{ retryAttempt: { lt: RETRY_DELAYS_MS.length } }, { emailNotifiedAt: null }],
      },
      orderBy: { createdAt: "asc" },
    });
    for (const intervention of interventions) {
      await Promise.all([
        this.scheduleRetries(intervention).catch(() => {
          this.logger.error(
            { interventionId: intervention.id, kind: intervention.kind },
            "Failed to repair intervention retry schedule",
          );
        }),
        this.notifyOperations(intervention),
      ]);
    }
  }

  private async notifyOperations(intervention: {
    id: string;
    kind: VerificationInterventionKind;
    emailNotifiedAt: Date | null;
  }): Promise<void> {
    if (!this.operationsEmail || intervention.emailNotifiedAt) return;
    const claimedAt = new Date();
    const claimed = await this.databaseService.verificationIntervention.updateMany({
      where: { id: intervention.id, emailNotifiedAt: null },
      data: { emailNotifiedAt: claimedAt },
    });
    if (claimed.count === 0) return;
    const reviewUrl = `${getEmailPublicEnv().websiteUrl.replace(/\/$/, "")}/admin/interventions`;
    try {
      await this.emailService.sendEmail({
        to: this.operationsEmail,
        subject: "Verification intervention requires review",
        html: `<p>A ${intervention.kind.toLowerCase().replaceAll("_", " ")} task requires review.</p><p><a href="${reviewUrl}">Open the intervention queue</a></p>`,
      });
    } catch {
      await this.databaseService.verificationIntervention.updateMany({
        where: { id: intervention.id, emailNotifiedAt: claimedAt },
        data: { emailNotifiedAt: null },
      });
      this.logger.warn(
        { interventionId: intervention.id, kind: intervention.kind },
        "Failed to send intervention notification",
      );
    }
  }

  async retry(interventionId: string, attempt: number, openedAt?: number): Promise<void> {
    if (attempt < 1 || attempt > RETRY_DELAYS_MS.length) return;
    const intervention = await this.databaseService.verificationIntervention.findUnique({
      where: { id: interventionId },
      include: { chauffeurVerification: true, accountVerification: true },
    });
    if (
      !intervention ||
      intervention.status !== VerificationInterventionStatus.OPEN ||
      (openedAt !== undefined && intervention.createdAt.getTime() !== openedAt)
    ) {
      return;
    }

    let licenseEvidence: LicenseRetryEvidence | null = null;
    if (intervention.kind !== VerificationInterventionKind.CHAUFFEUR_FACE) {
      const evidenceResult = this.licenseRetryEvidence(intervention);
      if (evidenceResult.kind === "UNREADABLE_PAYLOAD") {
        this.logger.error(
          { interventionId: intervention.id, kind: intervention.kind },
          "Verification intervention payload could not be decrypted",
        );
        return;
      }
      if (evidenceResult.kind === "INVALID_IDENTITY") {
        const rejected = await this.rejectProviderDecision(
          intervention.id,
          "EVIDENCE_CORRUPTED",
          "EVIDENCE_CORRUPTED",
        );
        if (rejected) {
          this.logger.error(
            { interventionId: intervention.id, kind: intervention.kind },
            "Verification intervention evidence could not be validated",
          );
          throw new InterventionNotFoundException();
        }
        return;
      }
      licenseEvidence = evidenceResult.evidence;
    } else if (!intervention.chauffeurVerification?.livenessProviderRef) {
      const rejected = await this.rejectProviderDecision(
        intervention.id,
        "EVIDENCE_CORRUPTED",
        "EVIDENCE_CORRUPTED",
      );
      if (rejected) {
        this.logger.error(
          { interventionId: intervention.id, kind: intervention.kind },
          "Verification intervention evidence could not be validated",
        );
        throw new InterventionNotFoundException();
      }
      return;
    }

    const claimedAt = new Date();
    const claimed = await this.databaseService.verificationIntervention.updateMany({
      where: {
        id: interventionId,
        status: VerificationInterventionStatus.OPEN,
        retryAttempt: { lt: attempt },
        ...(openedAt !== undefined ? { createdAt: new Date(openedAt) } : {}),
      },
      data: { retryAttempt: attempt, lastAttemptAt: claimedAt },
    });
    if (claimed.count === 0) return;

    try {
      if (intervention.kind === VerificationInterventionKind.CHAUFFEUR_FACE) {
        await this.retryFace({ ...intervention, retryAttempt: attempt });
        return;
      }
      await this.retryLicense({ ...intervention, retryAttempt: attempt }, licenseEvidence);
    } catch (error) {
      try {
        await this.databaseService.verificationIntervention.updateMany({
          where: {
            id: interventionId,
            status: VerificationInterventionStatus.OPEN,
            retryAttempt: attempt,
            lastAttemptAt: claimedAt,
          },
          data: {
            retryAttempt: intervention.retryAttempt,
            lastAttemptAt: intervention.lastAttemptAt,
          },
        });
      } catch {
        this.logger.error(
          { interventionId, kind: intervention.kind, attempt },
          "Failed to release verification intervention retry claim",
        );
      }
      this.logger.error(
        { interventionId, kind: intervention.kind, attempt },
        "Verification intervention retry failed unexpectedly",
      );
      throw error;
    }
  }

  private licenseRetryEvidence(intervention: DetailedIntervention): LicenseRetryEvidenceResult {
    if (!intervention.encryptedPayload) return { kind: "UNREADABLE_PAYLOAD" };
    const licenseNumber = this.tryDecrypt(intervention.encryptedPayload);
    if (!licenseNumber) return { kind: "UNREADABLE_PAYLOAD" };
    const identity =
      intervention.kind === VerificationInterventionKind.CHAUFFEUR_DRIVERS_LICENSE
        ? intervention.chauffeurVerification
          ? {
              identityFirstName: intervention.chauffeurVerification.identityFirstName,
              identityLastName: intervention.chauffeurVerification.identityLastName,
              dateOfBirth: intervention.chauffeurVerification.dateOfBirth,
            }
          : null
        : intervention.accountVerification
          ? {
              identityFirstName: intervention.accountVerification.identityFirstName,
              identityLastName: intervention.accountVerification.identityLastName,
              dateOfBirth: intervention.accountVerification.identityDateOfBirth,
            }
          : null;
    if (!identity?.identityFirstName || !identity.identityLastName || !identity.dateOfBirth) {
      return { kind: "INVALID_IDENTITY" };
    }
    return {
      kind: "VALID",
      evidence: {
        licenseNumber,
        identity: {
          identityFirstName: identity.identityFirstName,
          identityLastName: identity.identityLastName,
          dateOfBirth: identity.dateOfBirth,
        },
      },
    };
  }

  private async retryLicense(
    intervention: DetailedIntervention,
    { licenseNumber, identity }: LicenseRetryEvidence,
  ): Promise<void> {
    try {
      const license = await this.driversLicenseLookupService.lookup(
        licenseNumber,
        identity.identityFirstName,
        identity.identityLastName,
        identity.dateOfBirth,
      );
      if (!this.licenseMatches(identity, license, identity.dateOfBirth)) {
        await this.rejectProviderDecision(intervention.id, "IDENTITY_MISMATCH");
        return;
      }
      if (license.expiresAt < this.startOfTodayUtc()) {
        await this.rejectProviderDecision(intervention.id, "LICENSE_EXPIRED");
        return;
      }
      await this.resolveProviderLicense(intervention.id, license);
    } catch (error) {
      if (
        (error instanceof MonoError || error instanceof PremblyError) &&
        error.kind === "REJECTED"
      ) {
        await this.rejectProviderDecision(intervention.id, "PROVIDER_REJECTED");
        return;
      }
      if (
        (error instanceof MonoError || error instanceof PremblyError) &&
        ["UNAVAILABLE", "INVALID_RESPONSE"].includes(error.kind)
      ) {
        this.logger.warn(
          {
            interventionId: intervention.id,
            kind: intervention.kind,
            attempt: intervention.retryAttempt,
            providerOutcome: error.kind,
          },
          "Verification intervention retry remains unresolved",
        );
        return;
      }
      throw error;
    }
  }

  private async retryFace(intervention: DetailedIntervention): Promise<void> {
    const verification = intervention.chauffeurVerification;
    if (!verification?.livenessProviderRef) return;
    try {
      const status = await this.smileIdService.comparisonStatus(verification.livenessProviderRef);
      if (status === "clear") {
        await this.resolveFace(intervention.id, VerificationInterventionStatus.AUTO_RESOLVED);
      } else if (status === "block") {
        await this.rejectProviderDecision(intervention.id, "BIOMETRIC_BLOCK");
      }
    } catch (error) {
      if (error instanceof SmileIdError) {
        this.logger.warn(
          {
            interventionId: intervention.id,
            kind: intervention.kind,
            attempt: intervention.retryAttempt,
            providerOutcome: error.kind,
          },
          "Face intervention retry remains unresolved",
        );
        return;
      }
      throw error;
    }
  }

  private async resolveProviderLicense(
    interventionId: string,
    license: MonoDriversLicenseResult,
  ): Promise<void> {
    const intervention = await this.databaseService.verificationIntervention.findUnique({
      where: { id: interventionId },
      include: { chauffeurVerification: true, accountVerification: true },
    });
    if (!intervention) return;
    const resolvedAt = new Date();
    const won = await this.databaseService.$transaction(async (tx) => {
      const resolved = await tx.verificationIntervention.updateMany({
        where: { id: interventionId, status: VerificationInterventionStatus.OPEN },
        data: {
          status: VerificationInterventionStatus.AUTO_RESOLVED,
          encryptedPayload: null,
          resolvedAt,
          resolutionSource: "PROVIDER_RETRY",
        },
      });
      if (resolved.count === 0) return false;

      if (intervention.chauffeurVerificationId) {
        await tx.chauffeurVerification.update({
          where: { id: intervention.chauffeurVerificationId },
          data: {
            driversLicenseDecision: VerificationDecisionStatus.APPROVED,
            driversLicenseExpiresAt: license.expiresAt,
            driversLicenseProviderRef: license.reference,
          },
        });
      } else if (intervention.accountVerificationId) {
        await tx.fleetOwnerAccountVerification.update({
          where: { id: intervention.accountVerificationId },
          data: {
            driversLicenseDecision: VerificationDecisionStatus.APPROVED,
            driversLicenseExpiresAt: license.expiresAt,
            driversLicenseProviderRef: license.reference,
          },
        });
        await this.autoApproveOwnerAfterRecovery(tx, intervention.accountVerificationId);
      }
      return true;
    });
    if (won && intervention.chauffeurVerificationId) {
      try {
        await this.chauffeurActivationService.activateIfEligible(
          intervention.chauffeurVerificationId,
        );
      } catch (error) {
        await this.databaseService.verificationIntervention.updateMany({
          where: {
            id: interventionId,
            status: VerificationInterventionStatus.AUTO_RESOLVED,
            resolutionSource: "PROVIDER_RETRY",
          },
          data: {
            status: VerificationInterventionStatus.OPEN,
            encryptedPayload: intervention.encryptedPayload,
            resolvedAt: null,
            resolutionSource: null,
          },
        });
        throw error;
      }
    }
  }

  private async autoApproveOwnerAfterRecovery(
    tx: Prisma.TransactionClient,
    verificationId: string,
    reviewer?: { id: string; notes: string },
  ): Promise<void> {
    const verification = await tx.fleetOwnerAccountVerification.findUnique({
      where: { id: verificationId },
    });
    if (
      !verification ||
      verification.status !== AccountVerificationStatus.REVIEW_REQUIRED ||
      verification.identityRequiresReview ||
      verification.bankNameMatch === NameMatchStatus.REVIEW_REQUIRED
    ) {
      return;
    }
    const now = new Date();
    await tx.fleetOwnerAccountVerification.update({
      where: { id: verification.id },
      data: {
        status: AccountVerificationStatus.SUCCEEDED,
        reviewedAt: now,
        reviewedById: reviewer?.id,
        reviewNotes: reviewer?.notes,
      },
    });
    await tx.bankDetails.updateMany({
      where: { userId: verification.userId },
      data: { isVerified: true, lastVerifiedAt: now },
    });
    await tx.user.update({
      where: { id: verification.userId },
      data: { hasOnboarded: true, fleetOwnerStatus: FleetOwnerStatus.APPROVED },
    });
  }

  async recordSmileResult(
    verificationId: string,
    status: "clear" | "attention" | "block" | "error",
  ): Promise<void> {
    if (status === "clear") {
      await this.resolveFaceForVerification(
        verificationId,
        VerificationInterventionStatus.AUTO_RESOLVED,
      );
      return;
    }
    if (status === "block") {
      const intervention = await this.databaseService.verificationIntervention.findUnique({
        where: { resourceKey: `chauffeur-face:${verificationId}` },
      });
      if (intervention) await this.rejectProviderDecision(intervention.id, "BIOMETRIC_BLOCK");
      else await this.rejectChauffeur(verificationId, "BIOMETRIC_BLOCK");
      return;
    }
    await this.openChauffeurFace(verificationId);
  }

  private async resolveFace(
    interventionId: string,
    status:
      | (typeof VerificationInterventionStatus)["APPROVED"]
      | (typeof VerificationInterventionStatus)["AUTO_RESOLVED"],
    reviewer?: { id: string; notes: string; source: string },
  ): Promise<void> {
    const intervention = await this.databaseService.verificationIntervention.findUnique({
      where: { id: interventionId },
    });
    if (!intervention?.chauffeurVerificationId) throw new InterventionNotFoundException();
    await this.resolveFaceForVerification(
      intervention.chauffeurVerificationId,
      status,
      interventionId,
      reviewer,
    );
  }

  private async resolveFaceForVerification(
    verificationId: string,
    status:
      | (typeof VerificationInterventionStatus)["APPROVED"]
      | (typeof VerificationInterventionStatus)["AUTO_RESOLVED"],
    interventionId?: string,
    reviewer?: { id: string; notes: string; source: string },
  ): Promise<void> {
    const outcome = await this.databaseService.$transaction(async (tx) => {
      await this.lockChauffeurVerification(tx, verificationId);
      const verification = await tx.chauffeurVerification.findUnique({
        where: { id: verificationId },
        select: { status: true, faceDecision: true },
      });
      if (!verification) throw new InterventionNotFoundException();
      const intervention = interventionId
        ? await tx.verificationIntervention.findUnique({ where: { id: interventionId } })
        : await tx.verificationIntervention.findUnique({
            where: { resourceKey: `chauffeur-face:${verificationId}` },
          });
      if (
        intervention &&
        (intervention.kind !== VerificationInterventionKind.CHAUFFEUR_FACE ||
          intervention.chauffeurVerificationId !== verificationId)
      ) {
        throw new InterventionNotFoundException();
      }
      if (verification.status === ChauffeurVerificationStatus.APPROVED) {
        if (intervention?.status === VerificationInterventionStatus.OPEN) {
          await tx.verificationIntervention.update({
            where: { id: intervention.id },
            data: {
              status: VerificationInterventionStatus.AUTO_RESOLVED,
              resolvedAt: new Date(),
              resolutionSource: "ALREADY_APPROVED",
            },
          });
        }
        return { state: "ALREADY_APPROVED" as const, interventionId: intervention?.id };
      }
      if (
        verification.faceDecision === VerificationDecisionStatus.REJECTED ||
        (intervention && intervention.status === VerificationInterventionStatus.REJECTED)
      ) {
        return { state: "LOST" as const, interventionId: intervention?.id };
      }
      if (intervention) {
        const resolved = await tx.verificationIntervention.updateMany({
          where: { id: intervention.id, status: VerificationInterventionStatus.OPEN },
          data: {
            status,
            resolvedAt: new Date(),
            resolvedById: reviewer?.id,
            resolutionNotes: reviewer?.notes,
            resolutionSource: reviewer?.source ?? "SMILE_ID_RETRY",
          },
        });
        if (resolved.count === 0) {
          return { state: "LOST" as const, interventionId: intervention.id };
        }
      } else if (interventionId || reviewer) {
        throw new InterventionNotFoundException();
      }
      await tx.chauffeurVerification.update({
        where: { id: verificationId },
        data: { faceDecision: VerificationDecisionStatus.APPROVED },
      });
      return { state: "RESOLVED" as const, interventionId: intervention?.id };
    });
    if (outcome.state !== "RESOLVED") {
      if (reviewer) throw new InterventionAlreadyResolvedException();
      return;
    }
    try {
      await this.chauffeurActivationService.activateIfEligible(verificationId);
    } catch (error) {
      if (
        !reviewer &&
        status === VerificationInterventionStatus.AUTO_RESOLVED &&
        outcome.interventionId
      ) {
        await this.databaseService.verificationIntervention.updateMany({
          where: {
            id: outcome.interventionId,
            status: VerificationInterventionStatus.AUTO_RESOLVED,
          },
          data: {
            status: VerificationInterventionStatus.OPEN,
            resolvedAt: null,
            resolutionSource: null,
          },
        });
      }
      throw error;
    }
  }

  private async rejectProviderDecision(
    interventionId: string,
    reason: string,
    resolutionSource = "PROVIDER_RETRY",
  ): Promise<boolean> {
    const result = await this.databaseService.$transaction(async (tx) => {
      const intervention = await tx.verificationIntervention.findUnique({
        where: { id: interventionId },
      });
      if (!intervention) {
        return { won: false, selfieObjectKey: null, chauffeurVerificationId: null };
      }
      if (intervention.chauffeurVerificationId) {
        await this.lockChauffeurVerification(tx, intervention.chauffeurVerificationId);
        const verification = await tx.chauffeurVerification.findUnique({
          where: { id: intervention.chauffeurVerificationId },
          select: { status: true },
        });
        if (verification?.status === ChauffeurVerificationStatus.APPROVED) {
          await tx.verificationIntervention.updateMany({
            where: { id: interventionId, status: VerificationInterventionStatus.OPEN },
            data: {
              status: VerificationInterventionStatus.AUTO_RESOLVED,
              encryptedPayload: null,
              resolvedAt: new Date(),
              resolutionSource: "ALREADY_APPROVED",
            },
          });
          return {
            won: false,
            selfieObjectKey: null,
            chauffeurVerificationId: intervention.chauffeurVerificationId,
          };
        }
      }
      const won = await tx.verificationIntervention.updateMany({
        where: { id: interventionId, status: VerificationInterventionStatus.OPEN },
        data: {
          status: VerificationInterventionStatus.REJECTED,
          encryptedPayload: null,
          resolvedAt: new Date(),
          resolutionSource,
          resolutionNotes: reason,
        },
      });
      if (won.count === 0) {
        return {
          won: false,
          selfieObjectKey: null,
          chauffeurVerificationId: intervention.chauffeurVerificationId,
        };
      }
      if (intervention.chauffeurVerificationId) {
        return {
          won: true,
          selfieObjectKey: await this.rejectChauffeurInTransaction(
            tx,
            intervention.chauffeurVerificationId,
            reason,
            intervention.kind === VerificationInterventionKind.CHAUFFEUR_FACE ? "FACE" : "LICENSE",
          ),
          chauffeurVerificationId: intervention.chauffeurVerificationId,
        };
      }
      if (intervention.accountVerificationId) {
        await this.rejectOwnerVerification(tx, intervention.accountVerificationId, reason);
      }
      return { won: true, selfieObjectKey: null, chauffeurVerificationId: null };
    });
    if (result.won && result.selfieObjectKey && result.chauffeurVerificationId) {
      await this.purgeSelfie(result.selfieObjectKey, result.chauffeurVerificationId);
    }
    return result.won;
  }

  private async rejectChauffeur(verificationId: string, reason: string): Promise<void> {
    const selfieObjectKey = await this.databaseService.$transaction(async (tx) => {
      await this.lockChauffeurVerification(tx, verificationId);
      const verification = await tx.chauffeurVerification.findUnique({
        where: { id: verificationId },
        select: { status: true },
      });
      if (!verification || verification.status === ChauffeurVerificationStatus.APPROVED) {
        return null;
      }
      return this.rejectChauffeurInTransaction(tx, verificationId, reason, "FACE");
    });
    if (selfieObjectKey) {
      await this.purgeSelfie(selfieObjectKey, verificationId);
    }
  }

  private async rejectChauffeurInTransaction(
    tx: Prisma.TransactionClient,
    verificationId: string,
    reason: string,
    decision: "FACE" | "LICENSE",
  ): Promise<string | null> {
    const verification = await tx.chauffeurVerification.findUnique({
      where: { id: verificationId },
      select: { selfieObjectKey: true },
    });
    await tx.chauffeurVerification.update({
      where: { id: verificationId },
      data: {
        faceDecision: decision === "FACE" ? VerificationDecisionStatus.REJECTED : undefined,
        driversLicenseDecision:
          decision === "LICENSE" ? VerificationDecisionStatus.REJECTED : undefined,
        selfieObjectKey: null,
        identityOfficialPhoto: null,
        livenessProviderRef: null,
      },
    });
    await tx.chauffeurVerificationStageRequest.updateMany({
      where: {
        verificationId,
        stage: ChauffeurVerificationStage.DRIVING,
        status: ProviderVerificationStatus.PROCESSING,
      },
      data: { status: ProviderVerificationStatus.FAILED, failureReason: reason },
    });
    await tx.verificationIntervention.updateMany({
      where: {
        chauffeurVerificationId: verificationId,
        status: VerificationInterventionStatus.OPEN,
      },
      data: {
        status: VerificationInterventionStatus.REJECTED,
        encryptedPayload: null,
        resolvedAt: new Date(),
        resolutionSource: "TERMINAL_SIBLING_DECISION",
        resolutionNotes: reason,
      },
    });
    return verification?.selfieObjectKey ?? null;
  }

  private async purgeSelfie(key: string, verificationId: string): Promise<void> {
    await this.storageService.deleteObjectByKey(key).catch(() => {
      this.logger.warn({ verificationId }, "Failed to purge rejected chauffeur selfie");
    });
  }

  private async rejectOwnerVerification(
    tx: Prisma.TransactionClient,
    verificationId: string,
    reason: string,
  ): Promise<void> {
    const verification = await tx.fleetOwnerAccountVerification.update({
      where: { id: verificationId },
      data: {
        driversLicenseDecision: VerificationDecisionStatus.REJECTED,
        status: AccountVerificationStatus.FAILED,
        failureReason: reason,
      },
      select: { userId: true },
    });
    await tx.bankDetails.updateMany({
      where: { userId: verification.userId },
      data: { isVerified: false },
    });
    await tx.user.update({
      where: { id: verification.userId },
      data: { hasOnboarded: false, fleetOwnerStatus: FleetOwnerStatus.ON_HOLD },
    });
  }

  async list(query: ListInterventionsDto) {
    const where = { status: query.status };
    const [items, total] = await Promise.all([
      this.databaseService.verificationIntervention.findMany({
        where,
        include: {
          chauffeurVerification: {
            select: {
              name: true,
              driversLicenseLast4: true,
              selfieObjectKey: true,
              identityOfficialPhoto: true,
            },
          },
          accountVerification: {
            select: {
              legalName: true,
              driversLicenseLast4: true,
              userId: true,
            },
          },
          documentApproval: {
            select: { id: true, userId: true, status: true },
          },
        },
        orderBy: { createdAt: "asc" },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.databaseService.verificationIntervention.count({ where }),
    ]);
    return {
      items: items.map((item) => ({
        id: item.id,
        kind: item.kind,
        status: item.status,
        applicantName:
          item.chauffeurVerification?.name ?? item.accountVerification?.legalName ?? "Applicant",
        licenseLast4:
          item.chauffeurVerification?.driversLicenseLast4 ??
          item.accountVerification?.driversLicenseLast4 ??
          null,
        hasSelfie:
          item.kind === VerificationInterventionKind.CHAUFFEUR_FACE &&
          Boolean(item.chauffeurVerification?.selfieObjectKey),
        hasNinPortrait:
          item.kind === VerificationInterventionKind.CHAUFFEUR_FACE &&
          Boolean(item.chauffeurVerification?.identityOfficialPhoto),
        document: item.documentApproval,
        retryAttempt: item.retryAttempt,
        createdAt: item.createdAt,
      })),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  async getLicenseNumber(interventionId: string): Promise<string> {
    const intervention = await this.databaseService.verificationIntervention.findUnique({
      where: { id: interventionId },
    });
    if (
      !intervention ||
      intervention.kind !== VerificationInterventionKind.CHAUFFEUR_DRIVERS_LICENSE ||
      intervention.status !== VerificationInterventionStatus.OPEN ||
      !intervention.encryptedPayload
    ) {
      throw new InterventionNotFoundException();
    }
    return this.decrypt(intervention.encryptedPayload);
  }

  async getSelfie(interventionId: string) {
    const intervention = await this.databaseService.verificationIntervention.findUnique({
      where: { id: interventionId },
      include: { chauffeurVerification: { select: { selfieObjectKey: true } } },
    });
    const key = intervention?.chauffeurVerification?.selfieObjectKey;
    if (
      !intervention ||
      intervention.kind !== VerificationInterventionKind.CHAUFFEUR_FACE ||
      intervention.status !== VerificationInterventionStatus.OPEN ||
      !key
    ) {
      throw new InterventionNotFoundException();
    }
    return this.storageService.getObjectStream(key);
  }

  async getNinPortrait(interventionId: string): Promise<Buffer> {
    const intervention = await this.databaseService.verificationIntervention.findUnique({
      where: { id: interventionId },
      include: { chauffeurVerification: { select: { identityOfficialPhoto: true } } },
    });
    const photo = intervention?.chauffeurVerification?.identityOfficialPhoto;
    if (
      !intervention ||
      intervention.kind !== VerificationInterventionKind.CHAUFFEUR_FACE ||
      intervention.status !== VerificationInterventionStatus.OPEN ||
      !photo
    ) {
      throw new InterventionNotFoundException();
    }
    const encoded = photo.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "");
    const portrait = Buffer.from(encoded, "base64");
    if (portrait.length === 0) throw new InterventionNotFoundException();
    return portrait;
  }

  async approve(
    interventionId: string,
    reviewerId: string,
    input: ApproveInterventionDto,
  ): Promise<void> {
    const intervention = await this.databaseService.verificationIntervention.findUnique({
      where: { id: interventionId },
    });
    if (!intervention) throw new InterventionNotFoundException();
    if (intervention.kind === VerificationInterventionKind.OWNER_DRIVER_LICENSE) {
      throw new InterventionEvidenceRequiredException(
        "Approve the submitted driver's licence document to replace the provider result",
      );
    }
    if (
      intervention.kind === VerificationInterventionKind.CHAUFFEUR_DRIVERS_LICENSE &&
      !input.authoritativeSourceAttested
    ) {
      throw new InterventionEvidenceRequiredException(
        "Confirm an independent authoritative source such as FRSC was checked",
      );
    }
    if (intervention.kind === VerificationInterventionKind.CHAUFFEUR_FACE) {
      await this.resolveFace(interventionId, VerificationInterventionStatus.APPROVED, {
        id: reviewerId,
        notes: input.notes,
        source: input.source,
      });
      return;
    }
    if (!intervention.chauffeurVerificationId) throw new InterventionNotFoundException();
    const verificationId = intervention.chauffeurVerificationId;

    const resolvedAt = new Date();
    const resolved = await this.databaseService.$transaction(async (tx) => {
      const won = await tx.verificationIntervention.updateMany({
        where: { id: interventionId, status: VerificationInterventionStatus.OPEN },
        data: {
          status: VerificationInterventionStatus.APPROVED,
          encryptedPayload: null,
          resolvedAt,
          resolvedById: reviewerId,
          resolutionNotes: input.notes,
          resolutionSource: input.source,
        },
      });
      if (won.count === 0) return false;
      await tx.chauffeurVerification.update({
        where: { id: verificationId },
        data: { driversLicenseDecision: VerificationDecisionStatus.APPROVED },
      });
      return true;
    });
    if (!resolved) throw new InterventionAlreadyResolvedException();
    await this.chauffeurActivationService.activateIfEligible(verificationId);
  }

  async reject(interventionId: string, reviewerId: string, notes: string): Promise<void> {
    const intervention = await this.databaseService.verificationIntervention.findUnique({
      where: { id: interventionId },
    });
    if (!intervention) throw new InterventionNotFoundException();
    const result = await this.databaseService.$transaction(async (tx) => {
      if (intervention.chauffeurVerificationId) {
        await this.lockChauffeurVerification(tx, intervention.chauffeurVerificationId);
        const verification = await tx.chauffeurVerification.findUnique({
          where: { id: intervention.chauffeurVerificationId },
          select: { status: true },
        });
        if (verification?.status === ChauffeurVerificationStatus.APPROVED) {
          await tx.verificationIntervention.updateMany({
            where: { id: interventionId, status: VerificationInterventionStatus.OPEN },
            data: {
              status: VerificationInterventionStatus.AUTO_RESOLVED,
              encryptedPayload: null,
              resolvedAt: new Date(),
              resolutionSource: "ALREADY_APPROVED",
            },
          });
          return { won: false, selfieObjectKey: null };
        }
      }
      const won = await tx.verificationIntervention.updateMany({
        where: { id: interventionId, status: VerificationInterventionStatus.OPEN },
        data: {
          status: VerificationInterventionStatus.REJECTED,
          encryptedPayload: null,
          resolvedAt: new Date(),
          resolvedById: reviewerId,
          resolutionNotes: notes,
          resolutionSource: "STAFF_REVIEW",
        },
      });
      if (won.count === 0) return { won: false, selfieObjectKey: null };
      if (intervention.chauffeurVerificationId) {
        return {
          won: true,
          selfieObjectKey: await this.rejectChauffeurInTransaction(
            tx,
            intervention.chauffeurVerificationId,
            "STAFF_REJECTED",
            intervention.kind === VerificationInterventionKind.CHAUFFEUR_FACE ? "FACE" : "LICENSE",
          ),
        };
      }
      if (intervention.accountVerificationId) {
        await this.rejectOwnerVerification(
          tx,
          intervention.accountVerificationId,
          "STAFF_REJECTED",
        );
      }
      return { won: true, selfieObjectKey: null };
    });
    if (!result.won) throw new InterventionAlreadyResolvedException();
    if (result.selfieObjectKey && intervention.chauffeurVerificationId) {
      await this.purgeSelfie(result.selfieObjectKey, intervention.chauffeurVerificationId);
    }
  }

  async approveOwnerLicenseDocument(interventionId: string, reviewerId: string): Promise<void> {
    const resolved = await this.databaseService.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM "VerificationIntervention" WHERE id = ${interventionId}::uuid FOR UPDATE`,
      );
      const intervention = await tx.verificationIntervention.findUnique({
        where: { id: interventionId },
        include: { accountVerification: { select: { id: true, userId: true } } },
      });
      if (
        !intervention ||
        intervention.kind !== VerificationInterventionKind.OWNER_DRIVER_LICENSE ||
        intervention.status !== VerificationInterventionStatus.OPEN ||
        !intervention.accountVerification ||
        !intervention.documentApprovalId
      ) {
        throw new InterventionNotFoundException();
      }
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM "DocumentApproval" WHERE id = ${intervention.documentApprovalId}::uuid FOR UPDATE`,
      );
      const document = await tx.documentApproval.findUnique({
        where: { id: intervention.documentApprovalId },
      });
      if (
        !document ||
        document.userId !== intervention.accountVerification.userId ||
        document.documentType !== "DRIVERS_LICENSE" ||
        document.status === DocumentStatus.REJECTED
      ) {
        throw new InterventionEvidenceRequiredException(
          "The driver's licence document linked to this intervention is unavailable",
        );
      }
      await tx.documentApproval.update({
        where: { id: document.id },
        data: {
          status: DocumentStatus.APPROVED,
          approvedById: reviewerId,
          approvedAt: new Date(),
          notes: null,
        },
      });
      const won = await tx.verificationIntervention.updateMany({
        where: { id: interventionId, status: VerificationInterventionStatus.OPEN },
        data: {
          status: VerificationInterventionStatus.APPROVED,
          encryptedPayload: null,
          resolvedAt: new Date(),
          resolvedById: reviewerId,
          resolutionSource: "UPLOADED_DOCUMENT",
          resolutionNotes: "Provider outage replaced by the linked private document",
        },
      });
      if (won.count === 0) return false;
      await tx.fleetOwnerAccountVerification.update({
        where: { id: intervention.accountVerification.id },
        data: { driversLicenseDecision: VerificationDecisionStatus.APPROVED },
      });
      await this.autoApproveOwnerAfterRecovery(tx, intervention.accountVerification.id, {
        id: reviewerId,
        notes: "Driver's licence provider outage replaced by the linked private document",
      });
      return true;
    });
    if (!resolved) throw new InterventionAlreadyResolvedException();
  }

  private licenseMatches(
    identity: { identityFirstName: string | null; identityLastName: string | null },
    license: MonoDriversLicenseResult,
    dateOfBirth: Date,
  ): boolean {
    return (
      this.normalizeName(identity.identityFirstName ?? "") ===
        this.normalizeName(license.firstName) &&
      this.normalizeName(identity.identityLastName ?? "") ===
        this.normalizeName(license.lastName) &&
      dateOfBirth.toISOString().slice(0, 10) === license.dateOfBirth.toISOString().slice(0, 10)
    );
  }

  private normalizeName(value: string): string {
    return value
      .normalize("NFKD")
      .replaceAll(/[^A-Za-z0-9]/g, "")
      .toUpperCase();
  }

  private startOfTodayUtc(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  private encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
  }

  private decrypt(value: string): string {
    const decrypted = this.tryDecrypt(value);
    if (!decrypted) throw new InterventionNotFoundException();
    return decrypted;
  }

  private tryDecrypt(value: string): string | null {
    try {
      const parts = value.split(".");
      if (parts.length !== 3) return null;
      const [iv, tag, encrypted] = parts.map((part) => Buffer.from(part, "base64url"));
      if (iv.length !== 12 || tag.length !== 16 || encrypted.length === 0) return null;
      const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
        "utf8",
      );
      return decrypted.length > 0 ? decrypted : null;
    } catch {
      return null;
    }
  }
}
