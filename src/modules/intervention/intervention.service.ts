import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import {
  AccountVerificationStatus,
  ChauffeurVerificationStage,
  ChauffeurVerificationStatus,
  DocumentStatus,
  FleetOwnerStatus,
  Prisma,
  ProviderVerificationStatus,
  VerificationDecisionStatus,
  VerificationInterventionKind,
  VerificationInterventionStatus,
} from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import type { EnvConfig } from "../../config/env.config";
import { getEmailPublicEnv } from "../../email-public-env";
import { DatabaseService } from "../database/database.service";
import { EmailService } from "../email/email.service";
import { StorageService } from "../storage/storage.service";
import { ChauffeurActivationService } from "./chauffeur-activation.service";
import type { ApproveInterventionDto, ListInterventionsDto } from "./intervention.dto";
import {
  InterventionAlreadyResolvedException,
  InterventionEvidenceRequiredException,
  InterventionNotFoundException,
} from "./intervention.error";

const FACE_KINDS = new Set<VerificationInterventionKind>([
  VerificationInterventionKind.CHAUFFEUR_FACE,
  VerificationInterventionKind.OWNER_DRIVER_FACE,
]);

const interventionSummaryInclude = {
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
      selfieObjectKey: true,
      identityOfficialPhoto: true,
    },
  },
  documentApproval: {
    select: { id: true, userId: true, status: true },
  },
} satisfies Prisma.VerificationInterventionInclude;

type InterventionSummaryRecord = Prisma.VerificationInterventionGetPayload<{
  include: typeof interventionSummaryInclude;
}>;

type TransactionClient = Prisma.TransactionClient;

@Injectable()
export class InterventionService {
  private readonly encryptionKey: Buffer;
  private readonly operationsEmail: string;

  constructor(
    configService: ConfigService<EnvConfig, true>,
    private readonly databaseService: DatabaseService,
    private readonly emailService: EmailService,
    private readonly storageService: StorageService,
    private readonly chauffeurActivationService: ChauffeurActivationService,
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

  bindChauffeurFace(tx: TransactionClient, verificationId: string) {
    return this.bindFaceIntervention(tx, {
      resourceKey: `chauffeur-face:${verificationId}`,
      kind: VerificationInterventionKind.CHAUFFEUR_FACE,
      chauffeurVerificationId: verificationId,
    });
  }

  bindOwnerFace(tx: TransactionClient, verificationId: string) {
    return this.bindFaceIntervention(tx, {
      resourceKey: `owner-face:${verificationId}`,
      kind: VerificationInterventionKind.OWNER_DRIVER_FACE,
      accountVerificationId: verificationId,
    });
  }

  private async bindFaceIntervention(
    tx: TransactionClient,
    data: {
      resourceKey: string;
      kind: VerificationInterventionKind;
      chauffeurVerificationId?: string;
      accountVerificationId?: string;
    },
  ) {
    const existing = await tx.verificationIntervention.findUnique({
      where: { resourceKey: data.resourceKey },
    });
    if (existing?.status === VerificationInterventionStatus.OPEN) return null;
    return tx.verificationIntervention.upsert({
      where: { resourceKey: data.resourceKey },
      create: data,
      update: {
        kind: data.kind,
        status: VerificationInterventionStatus.OPEN,
        chauffeurVerificationId: data.chauffeurVerificationId,
        accountVerificationId: data.accountVerificationId,
        emailNotifiedAt: null,
        resolutionSource: null,
        resolutionNotes: null,
        resolvedAt: null,
        resolvedById: null,
        createdAt: new Date(),
      },
    });
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
      await this.notifyOperations(intervention);
    } catch {
      this.logger.error(
        { interventionId },
        "Failed to dispatch verification intervention after commit",
      );
    }
  }

  private lockChauffeurVerification(tx: TransactionClient, verificationId: string) {
    return tx.$queryRaw(
      Prisma.sql`SELECT id FROM "ChauffeurVerification" WHERE id = ${verificationId}::uuid FOR UPDATE`,
    );
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async repairOpenInterventionDispatch(): Promise<void> {
    const interventions = await this.databaseService.verificationIntervention.findMany({
      where: {
        status: VerificationInterventionStatus.OPEN,
        emailNotifiedAt: null,
      },
      orderBy: { createdAt: "asc" },
    });
    for (const intervention of interventions) {
      await this.notifyOperations(intervention);
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

  private async resolveFace(
    interventionId: string,
    reviewer: { id: string; notes: string; source: string },
  ): Promise<void> {
    const intervention = await this.databaseService.verificationIntervention.findUnique({
      where: { id: interventionId },
    });
    if (
      intervention?.kind === VerificationInterventionKind.CHAUFFEUR_FACE &&
      intervention.chauffeurVerificationId
    ) {
      await this.resolveChauffeurFace(intervention, reviewer);
      return;
    }
    if (
      intervention?.kind === VerificationInterventionKind.OWNER_DRIVER_FACE &&
      intervention.accountVerificationId
    ) {
      await this.resolveOwnerFace(intervention, reviewer);
      return;
    }
    throw new InterventionNotFoundException();
  }

  private async resolveChauffeurFace(
    intervention: {
      id: string;
      chauffeurVerificationId: string | null;
    },
    reviewer: { id: string; notes: string; source: string },
  ): Promise<void> {
    const verificationId = intervention.chauffeurVerificationId;
    if (!verificationId) throw new InterventionNotFoundException();
    const outcome = await this.databaseService.$transaction(async (tx) => {
      await this.lockChauffeurVerification(tx, verificationId);
      const verification = await tx.chauffeurVerification.findUnique({
        where: { id: verificationId },
        select: { status: true, faceDecision: true },
      });
      if (!verification) throw new InterventionNotFoundException();
      if (verification.status === ChauffeurVerificationStatus.APPROVED) {
        await tx.verificationIntervention.updateMany({
          where: { id: intervention.id, status: VerificationInterventionStatus.OPEN },
          data: {
            status: VerificationInterventionStatus.AUTO_RESOLVED,
            resolvedAt: new Date(),
            resolutionSource: "ALREADY_APPROVED",
          },
        });
        return false;
      }
      if (verification.faceDecision === VerificationDecisionStatus.REJECTED) return false;
      const resolved = await tx.verificationIntervention.updateMany({
        where: { id: intervention.id, status: VerificationInterventionStatus.OPEN },
        data: {
          status: VerificationInterventionStatus.APPROVED,
          resolvedAt: new Date(),
          resolvedById: reviewer.id,
          resolutionNotes: reviewer.notes,
          resolutionSource: reviewer.source,
        },
      });
      if (resolved.count === 0) return false;
      await tx.chauffeurVerification.update({
        where: { id: verificationId },
        data: { faceDecision: VerificationDecisionStatus.APPROVED },
      });
      return true;
    });
    if (!outcome) throw new InterventionAlreadyResolvedException();
    try {
      await this.chauffeurActivationService.activateIfEligible(verificationId);
    } catch (error) {
      await this.reopenAfterActivationFailure(
        intervention.id,
        VerificationInterventionStatus.APPROVED,
      );
      throw error;
    }
  }

  private async resolveOwnerFace(
    intervention: { id: string; accountVerificationId: string | null },
    reviewer: { id: string; notes: string; source: string },
  ): Promise<void> {
    if (!intervention.accountVerificationId) throw new InterventionNotFoundException();
    const verificationId = intervention.accountVerificationId;
    const resolved = await this.databaseService.$transaction(async (tx) => {
      const won = await tx.verificationIntervention.updateMany({
        where: { id: intervention.id, status: VerificationInterventionStatus.OPEN },
        data: {
          status: VerificationInterventionStatus.APPROVED,
          resolvedAt: new Date(),
          resolvedById: reviewer.id,
          resolutionNotes: reviewer.notes,
          resolutionSource: reviewer.source,
        },
      });
      if (won.count === 0) return false;
      await tx.fleetOwnerAccountVerification.update({
        where: { id: verificationId },
        data: { faceDecision: VerificationDecisionStatus.APPROVED },
      });
      return true;
    });
    if (!resolved) throw new InterventionAlreadyResolvedException();
  }

  private reopenAfterActivationFailure(
    interventionId: string,
    status: VerificationInterventionStatus,
    encryptedPayload?: string | null,
  ) {
    return this.databaseService.verificationIntervention.updateMany({
      where: { id: interventionId, status },
      data: {
        status: VerificationInterventionStatus.OPEN,
        resolvedAt: null,
        resolvedById: null,
        resolutionNotes: null,
        resolutionSource: null,
        ...(encryptedPayload !== undefined ? { encryptedPayload } : {}),
      },
    });
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
    decision: "FACE" | "LICENSE",
  ): Promise<string | null> {
    const previous = await tx.fleetOwnerAccountVerification.findUnique({
      where: { id: verificationId },
      select: { selfieObjectKey: true },
    });
    const verification = await tx.fleetOwnerAccountVerification.update({
      where: { id: verificationId },
      data: {
        driversLicenseDecision:
          decision === "LICENSE" ? VerificationDecisionStatus.REJECTED : undefined,
        faceDecision: decision === "FACE" ? VerificationDecisionStatus.REJECTED : undefined,
        selfieObjectKey: null,
        identityOfficialPhoto: null,
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
    await tx.verificationIntervention.updateMany({
      where: {
        accountVerificationId: verificationId,
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
    return previous?.selfieObjectKey ?? null;
  }

  async list(query: ListInterventionsDto) {
    const where = { status: query.status };
    const [items, total] = await Promise.all([
      this.databaseService.verificationIntervention.findMany({
        where,
        include: interventionSummaryInclude,
        orderBy: { createdAt: "asc" },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.databaseService.verificationIntervention.count({ where }),
    ]);
    return {
      items: items.map((item) => this.toSummary(item)),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  async get(interventionId: string) {
    const item = await this.databaseService.verificationIntervention.findUnique({
      where: { id: interventionId },
      include: interventionSummaryInclude,
    });
    if (!item) throw new InterventionNotFoundException();
    return this.toSummary(item);
  }

  private toSummary(item: InterventionSummaryRecord) {
    return {
      id: item.id,
      kind: item.kind,
      status: item.status,
      applicantName:
        item.chauffeurVerification?.name ?? item.accountVerification?.legalName ?? "Applicant",
      licenseLast4:
        item.chauffeurVerification?.driversLicenseLast4 ??
        item.accountVerification?.driversLicenseLast4 ??
        null,
      hasSelfie: Boolean(
        item.chauffeurVerification?.selfieObjectKey ?? item.accountVerification?.selfieObjectKey,
      ),
      hasNinPortrait: Boolean(
        item.chauffeurVerification?.identityOfficialPhoto ??
          item.accountVerification?.identityOfficialPhoto,
      ),
      document: item.documentApproval,
      createdAt: item.createdAt,
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
      include: {
        chauffeurVerification: { select: { selfieObjectKey: true } },
        accountVerification: { select: { selfieObjectKey: true } },
      },
    });
    const key =
      intervention?.chauffeurVerification?.selfieObjectKey ??
      intervention?.accountVerification?.selfieObjectKey;
    if (
      !intervention ||
      !FACE_KINDS.has(intervention.kind) ||
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
      include: {
        chauffeurVerification: { select: { identityOfficialPhoto: true } },
        accountVerification: { select: { identityOfficialPhoto: true } },
      },
    });
    const photo =
      intervention?.chauffeurVerification?.identityOfficialPhoto ??
      intervention?.accountVerification?.identityOfficialPhoto;
    if (
      !intervention ||
      !FACE_KINDS.has(intervention.kind) ||
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
    if (
      intervention.kind === VerificationInterventionKind.CHAUFFEUR_FACE ||
      intervention.kind === VerificationInterventionKind.OWNER_DRIVER_FACE
    ) {
      await this.resolveFace(interventionId, {
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
    try {
      await this.chauffeurActivationService.activateIfEligible(verificationId);
    } catch (error) {
      await this.reopenAfterActivationFailure(
        interventionId,
        VerificationInterventionStatus.APPROVED,
        intervention.encryptedPayload,
      );
      throw error;
    }
  }

  async requestRetake(interventionId: string, reviewerId: string, notes: string): Promise<void> {
    const result = await this.databaseService.$transaction(async (tx) => {
      const intervention = await tx.verificationIntervention.findUnique({
        where: { id: interventionId },
      });
      if (!intervention || !FACE_KINDS.has(intervention.kind)) {
        throw new InterventionNotFoundException();
      }
      const resolved = await tx.verificationIntervention.updateMany({
        where: { id: interventionId, status: VerificationInterventionStatus.OPEN },
        data: {
          status: VerificationInterventionStatus.RETAKE_REQUESTED,
          resolvedAt: new Date(),
          resolvedById: reviewerId,
          resolutionNotes: notes,
          resolutionSource: "STAFF_REVIEW",
        },
      });
      if (resolved.count === 0) throw new InterventionAlreadyResolvedException();
      if (intervention.chauffeurVerificationId) {
        const verification = await tx.chauffeurVerification.findUnique({
          where: { id: intervention.chauffeurVerificationId },
          select: { selfieObjectKey: true },
        });
        await tx.chauffeurVerification.update({
          where: { id: intervention.chauffeurVerificationId },
          data: {
            selfieObjectKey: null,
            selfieRetakeRequired: true,
            faceDecision: VerificationDecisionStatus.PENDING,
            livenessProviderRef: null,
          },
        });
        await tx.chauffeurVerificationStageRequest.updateMany({
          where: {
            verificationId: intervention.chauffeurVerificationId,
            stage: ChauffeurVerificationStage.DRIVING,
            status: ProviderVerificationStatus.PROCESSING,
          },
          data: {
            status: ProviderVerificationStatus.FAILED,
            failureReason: "SELFIE_RETAKE_REQUIRED",
          },
        });
        return {
          selfieObjectKey: verification.selfieObjectKey,
          verificationId: intervention.chauffeurVerificationId,
        };
      }
      if (intervention.accountVerificationId) {
        const verification = await tx.fleetOwnerAccountVerification.findUnique({
          where: { id: intervention.accountVerificationId },
          select: { selfieObjectKey: true },
        });
        await tx.fleetOwnerAccountVerification.update({
          where: { id: intervention.accountVerificationId },
          data: {
            selfieObjectKey: null,
            selfieRetakeRequired: true,
            faceDecision: VerificationDecisionStatus.PENDING,
          },
        });
        return {
          selfieObjectKey: verification.selfieObjectKey,
          verificationId: intervention.accountVerificationId,
        };
      }
      throw new InterventionNotFoundException();
    });
    if (result.selfieObjectKey) {
      await this.purgeSelfie(result.selfieObjectKey, result.verificationId);
    }
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
          return { won: false, selfieObjectKey: null, verificationId: null };
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
      if (won.count === 0) {
        return { won: false, selfieObjectKey: null, verificationId: null };
      }
      if (intervention.chauffeurVerificationId) {
        return {
          won: true,
          selfieObjectKey: await this.rejectChauffeurInTransaction(
            tx,
            intervention.chauffeurVerificationId,
            "STAFF_REJECTED",
            intervention.kind === VerificationInterventionKind.CHAUFFEUR_FACE ? "FACE" : "LICENSE",
          ),
          verificationId: intervention.chauffeurVerificationId,
        };
      }
      if (intervention.accountVerificationId) {
        return {
          won: true,
          selfieObjectKey: await this.rejectOwnerVerification(
            tx,
            intervention.accountVerificationId,
            "STAFF_REJECTED",
            intervention.kind === VerificationInterventionKind.OWNER_DRIVER_FACE
              ? "FACE"
              : "LICENSE",
          ),
          verificationId: intervention.accountVerificationId,
        };
      }
      return { won: true, selfieObjectKey: null, verificationId: null };
    });
    if (!result.won) throw new InterventionAlreadyResolvedException();
    if (result.selfieObjectKey && result.verificationId) {
      await this.purgeSelfie(result.selfieObjectKey, result.verificationId);
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
      return true;
    });
    if (!resolved) throw new InterventionAlreadyResolvedException();
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
