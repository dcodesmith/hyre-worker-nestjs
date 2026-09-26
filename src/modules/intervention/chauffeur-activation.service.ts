import { Injectable } from "@nestjs/common";
import {
  ChauffeurApprovalStatus,
  ChauffeurVerificationStage,
  ChauffeurVerificationStatus,
  Prisma,
  ProviderVerificationStatus,
  VerificationDecisionStatus,
} from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { USER } from "../auth/auth.const";
import { ChauffeurErrorCode } from "../chauffeur/chauffeur.error";
import {
  DatabaseService,
  isUniqueConstraintError,
  lockUserRow,
} from "../database/database.service";
import { StorageService } from "../storage/storage.service";

type AccountConflictResult = {
  handled: boolean;
  activated: boolean;
  selfieObjectKey: string | null;
};

@Injectable()
export class ChauffeurActivationService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly storageService: StorageService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ChauffeurActivationService.name);
  }

  async activateIfEligible(verificationId: string): Promise<boolean> {
    let selfieObjectKey: string | null = null;
    let activated: boolean;
    try {
      activated = await this.databaseService.$transaction(async (tx) => {
        await this.lockVerification(tx, verificationId);
        const verification = await tx.chauffeurVerification.findUnique({
          where: { id: verificationId },
        });
        if (!verification) return false;
        if (verification.status === ChauffeurVerificationStatus.APPROVED) return true;
        if (
          verification.driversLicenseDecision !== VerificationDecisionStatus.APPROVED ||
          verification.faceDecision !== VerificationDecisionStatus.APPROVED
        ) {
          return false;
        }
        const openInterventions = await tx.verificationIntervention.count({
          where: {
            chauffeurVerificationId: verification.id,
            status: "OPEN",
            kind: { in: ["CHAUFFEUR_DRIVERS_LICENSE", "CHAUFFEUR_FACE"] },
          },
        });
        if (openInterventions > 0) return false;

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
        if (existing && this.isConflictingUser(existing, verification.fleetOwnerId)) {
          selfieObjectKey = await this.failAccountConflict(tx, verification);
          return false;
        }

        const legalName = [
          verification.identityFirstName,
          verification.identityMiddleName,
          verification.identityLastName,
        ]
          .filter(Boolean)
          .join(" ");
        const data = {
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
        };
        const chauffeur = existing
          ? await tx.user.update({ where: { id: existing.id }, data, select: { id: true } })
          : await tx.user.create({
              data: { ...data, email: verification.email },
              select: { id: true },
            });

        selfieObjectKey = verification.selfieObjectKey;
        await tx.chauffeurVerification.update({
          where: { id: verification.id },
          data: {
            chauffeurId: chauffeur.id,
            status: ChauffeurVerificationStatus.APPROVED,
            selfieObjectKey: null,
            identityOfficialPhoto: null,
          },
        });
        await tx.chauffeurVerificationStageRequest.updateMany({
          where: {
            verificationId,
            stage: ChauffeurVerificationStage.DRIVING,
            status: ProviderVerificationStatus.PROCESSING,
          },
          data: { status: ProviderVerificationStatus.SUCCEEDED, failureReason: null },
        });
        return true;
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const conflict = await this.resolveRolledBackUniqueConflict(verificationId);
      if (!conflict.handled) throw error;
      activated = conflict.activated;
      selfieObjectKey = conflict.selfieObjectKey;
    }

    if (selfieObjectKey) {
      await this.storageService.deleteObjectByKey(selfieObjectKey).catch(() => {
        this.logger.warn({ verificationId }, "Failed to purge terminal chauffeur selfie");
      });
    }
    return activated;
  }

  private lockVerification(tx: Prisma.TransactionClient, verificationId: string) {
    return tx.$queryRaw(
      Prisma.sql`SELECT id FROM "ChauffeurVerification" WHERE id = ${verificationId}::uuid FOR UPDATE`,
    );
  }

  private isConflictingUser(
    user: {
      id: string;
      fleetOwnerId: string | null;
      isOwnerDriver: boolean;
      roles: Array<{ name: string }>;
    },
    fleetOwnerId: string,
  ): boolean {
    return (
      user.id === fleetOwnerId ||
      user.isOwnerDriver ||
      Boolean(user.fleetOwnerId && user.fleetOwnerId !== fleetOwnerId) ||
      user.roles.some(({ name }) => name !== USER)
    );
  }

  private async failAccountConflict(
    tx: Prisma.TransactionClient,
    verification: {
      id: string;
      selfieObjectKey: string | null;
    },
  ): Promise<string | null> {
    await tx.chauffeurVerification.update({
      where: { id: verification.id },
      data: { selfieObjectKey: null, identityOfficialPhoto: null },
    });
    await tx.chauffeurVerificationStageRequest.updateMany({
      where: {
        verificationId: verification.id,
        stage: ChauffeurVerificationStage.DRIVING,
        status: ProviderVerificationStatus.PROCESSING,
      },
      data: {
        status: ProviderVerificationStatus.FAILED,
        failureReason: ChauffeurErrorCode.ACCOUNT_CONFLICT,
      },
    });
    await tx.verificationIntervention.updateMany({
      where: { chauffeurVerificationId: verification.id, status: "OPEN" },
      data: {
        status: "REJECTED",
        encryptedPayload: null,
        resolvedAt: new Date(),
        resolutionSource: "ACCOUNT_CONFLICT",
      },
    });
    return verification.selfieObjectKey;
  }

  private resolveRolledBackUniqueConflict(verificationId: string): Promise<AccountConflictResult> {
    return this.databaseService.$transaction(async (tx) => {
      await this.lockVerification(tx, verificationId);
      const verification = await tx.chauffeurVerification.findUnique({
        where: { id: verificationId },
      });
      if (!verification) {
        return { handled: false, activated: false, selfieObjectKey: null };
      }
      if (verification.status === ChauffeurVerificationStatus.APPROVED) {
        return { handled: true, activated: true, selfieObjectKey: null };
      }

      const approvedNinConflict = verification.ninHash
        ? await tx.chauffeurVerification.findFirst({
            where: {
              id: { not: verification.id },
              ninHash: verification.ninHash,
              status: ChauffeurVerificationStatus.APPROVED,
            },
            select: { id: true },
          })
        : null;
      const existingUser = await tx.user.findFirst({
        where: { email: { equals: verification.email, mode: "insensitive" } },
        select: {
          id: true,
          fleetOwnerId: true,
          isOwnerDriver: true,
          roles: { select: { name: true } },
          chauffeurVerification: { select: { id: true } },
        },
      });
      const userConflict =
        existingUser &&
        (this.isConflictingUser(existingUser, verification.fleetOwnerId) ||
          (existingUser.chauffeurVerification !== null &&
            existingUser.chauffeurVerification.id !== verification.id));
      if (!approvedNinConflict && !userConflict) {
        return { handled: false, activated: false, selfieObjectKey: null };
      }
      if (
        verification.driversLicenseDecision !== VerificationDecisionStatus.APPROVED ||
        verification.faceDecision !== VerificationDecisionStatus.APPROVED
      ) {
        return { handled: true, activated: false, selfieObjectKey: null };
      }

      return {
        handled: true,
        activated: false,
        selfieObjectKey: await this.failAccountConflict(tx, verification),
      };
    });
  }
}
