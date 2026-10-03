import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  AccountVerificationStatus,
  ChauffeurApprovalStatus,
  FleetOwnerAccountType,
  FleetOwnerStatus,
  Prisma,
  PrismaClient,
  VerificationDecisionStatus,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATION_SQL = readFileSync(
  join(
    process.cwd(),
    "prisma/migrations/20261003003000_backfill_legacy_owner_driver_chauffeur_approval/migration.sql",
  ),
  "utf8",
);

const FUTURE = new Date("2099-06-01T00:00:00.000Z");
const EXPIRED = new Date("2020-06-01T00:00:00.000Z");
const OLDER = new Date("2023-01-01T00:00:00.000Z");
const NEWER = new Date("2025-01-01T00:00:00.000Z");

class Rollback extends Error {}

async function createOwner(
  tx: Prisma.TransactionClient,
  email: string,
  data: {
    isOwnerDriver?: boolean;
    fleetOwnerStatus?: FleetOwnerStatus;
    chauffeurApprovalStatus?: ChauffeurApprovalStatus;
  } = {},
) {
  return tx.user.create({
    data: {
      email,
      isOwnerDriver: data.isOwnerDriver ?? true,
      fleetOwnerStatus: data.fleetOwnerStatus ?? FleetOwnerStatus.APPROVED,
      hasOnboarded: true,
      chauffeurApprovalStatus: data.chauffeurApprovalStatus ?? ChauffeurApprovalStatus.PENDING,
    },
    select: { id: true },
  });
}

async function createVerification(
  tx: Prisma.TransactionClient,
  userId: string,
  data: {
    createdAt?: Date;
    status?: AccountVerificationStatus;
    driversLicenseExpiresAt?: Date;
  } = {},
) {
  const key = randomUUID();
  await tx.fleetOwnerAccountVerification.create({
    data: {
      userId,
      idempotencyKey: key,
      requestHash: key,
      accountType: FleetOwnerAccountType.INDIVIDUAL,
      processingExpiresAt: FUTURE,
      isOwnerDriver: true,
      status: data.status ?? AccountVerificationStatus.SUCCEEDED,
      driversLicenseDecision: VerificationDecisionStatus.APPROVED,
      driversLicenseProviderRef: "provider-ref",
      driversLicenseExpiresAt: data.driversLicenseExpiresAt ?? FUTURE,
      createdAt: data.createdAt ?? OLDER,
    },
  });
}

async function approvalStatus(tx: Prisma.TransactionClient, email: string) {
  const user = await tx.user.findUniqueOrThrow({
    where: { email },
    select: { chauffeurApprovalStatus: true },
  });
  return user.chauffeurApprovalStatus;
}

describe("legacy owner-driver chauffeur approval backfill", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("DATABASE_URL is not set");

    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl }),
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("approves a pending legacy owner-driver and leaves rejected users rejected", async () => {
    const email = (label: string) => `legacy-od-${randomUUID()}-${label}@example.com`;
    const qualifyingEmail = email("qualifying");
    const rejectedEmail = email("rejected");
    const newerInvalidEmail = email("newer-invalid");
    const expiredEmail = email("expired");
    const nonOwnerEmail = email("non-owner");
    const unapprovedEmail = email("unapproved");

    try {
      await prisma.$transaction(async (tx) => {
        const qualifying = await createOwner(tx, qualifyingEmail);
        await createVerification(tx, qualifying.id);

        const rejected = await createOwner(tx, rejectedEmail, {
          chauffeurApprovalStatus: ChauffeurApprovalStatus.REJECTED,
        });
        await createVerification(tx, rejected.id);

        const newerInvalid = await createOwner(tx, newerInvalidEmail);
        await createVerification(tx, newerInvalid.id, { createdAt: OLDER });
        await createVerification(tx, newerInvalid.id, {
          createdAt: NEWER,
          status: AccountVerificationStatus.FAILED,
        });

        const expired = await createOwner(tx, expiredEmail);
        await createVerification(tx, expired.id, { driversLicenseExpiresAt: EXPIRED });

        const nonOwner = await createOwner(tx, nonOwnerEmail, { isOwnerDriver: false });
        await createVerification(tx, nonOwner.id);

        const unapproved = await createOwner(tx, unapprovedEmail, {
          fleetOwnerStatus: FleetOwnerStatus.PROCESSING,
        });
        await createVerification(tx, unapproved.id);

        await tx.$executeRawUnsafe(MIGRATION_SQL);

        expect(await approvalStatus(tx, qualifyingEmail)).toBe(ChauffeurApprovalStatus.APPROVED);
        expect(await approvalStatus(tx, rejectedEmail)).toBe(ChauffeurApprovalStatus.REJECTED);
        expect(await approvalStatus(tx, newerInvalidEmail)).toBe(ChauffeurApprovalStatus.PENDING);
        expect(await approvalStatus(tx, expiredEmail)).toBe(ChauffeurApprovalStatus.PENDING);
        expect(await approvalStatus(tx, nonOwnerEmail)).toBe(ChauffeurApprovalStatus.PENDING);
        expect(await approvalStatus(tx, unapprovedEmail)).toBe(ChauffeurApprovalStatus.PENDING);

        expect(await tx.$executeRawUnsafe(MIGRATION_SQL)).toBe(0);
        expect(await approvalStatus(tx, rejectedEmail)).toBe(ChauffeurApprovalStatus.REJECTED);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });
});
