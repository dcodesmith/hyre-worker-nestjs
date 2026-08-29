import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { ExtensionCreationIdempotencyState, Prisma } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { DatabaseService } from "../database/database.service";
import {
  EXTENSION_IDEMPOTENCY_PROCESSING_LEASE_MS,
  EXTENSION_IDEMPOTENCY_RETENTION_MS,
  EXTENSION_IDEMPOTENCY_RETRY_AFTER_SECONDS,
} from "./booking.const";
import {
  ExtensionCreationFailedException,
  ExtensionIdempotencyKeyReusedException,
  ExtensionRequestInProgressException,
} from "./booking.error";
import type { CreateExtensionResponse } from "./booking.interface";

export type ExtensionIdempotencyRequest = {
  bookingId: string;
  bookingLegId: string;
  hours: number;
  callbackUrl: string;
};

export type ExtensionIdempotencyClaim =
  | { kind: "claimed"; id: string }
  | { kind: "resume"; id: string; extensionId: string }
  | { kind: "replay"; response: CreateExtensionResponse };

@Injectable()
export class ExtensionCreationIdempotencyService {
  private static readonly maxClaimAttempts = 3;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ExtensionCreationIdempotencyService.name);
  }

  getCustomerScope(userId: string): string {
    return `user:${userId}`;
  }

  createRequestHash(request: ExtensionIdempotencyRequest): string {
    return createHash("sha256")
      .update(
        JSON.stringify([
          request.bookingId,
          request.bookingLegId,
          request.hours,
          request.callbackUrl,
        ]),
      )
      .digest("hex");
  }

  createPaymentIntentReference(idempotencyId: string): string {
    return `ext-${idempotencyId}`;
  }

  async findResolvedBookingLegId(
    customerScope: string,
    idempotencyKey: string,
  ): Promise<string | null> {
    const existing = await this.databaseService.extensionCreationIdempotency.findUnique({
      where: { customerScope_idempotencyKey: { customerScope, idempotencyKey } },
      select: { resolvedBookingLegId: true },
    });
    return existing?.resolvedBookingLegId ?? null;
  }

  async claim(
    customerScope: string,
    idempotencyKey: string,
    requestHash: string,
    resolvedBookingLegId: string,
  ): Promise<ExtensionIdempotencyClaim> {
    return this.claimWithAttempt(
      customerScope,
      idempotencyKey,
      requestHash,
      resolvedBookingLegId,
      1,
    );
  }

  private async claimWithAttempt(
    customerScope: string,
    idempotencyKey: string,
    requestHash: string,
    resolvedBookingLegId: string,
    attempt: number,
  ): Promise<ExtensionIdempotencyClaim> {
    if (attempt > ExtensionCreationIdempotencyService.maxClaimAttempts) {
      throw new ExtensionRequestInProgressException(EXTENSION_IDEMPOTENCY_RETRY_AFTER_SECONDS);
    }

    try {
      const created = await this.databaseService.extensionCreationIdempotency.create({
        data: { customerScope, idempotencyKey, requestHash, resolvedBookingLegId },
        select: { id: true },
      });
      return { kind: "claimed", id: created.id };
    } catch (error) {
      if (!this.isUniqueConstraintError(error)) throw error;
    }

    const existing = await this.databaseService.extensionCreationIdempotency.findUnique({
      where: { customerScope_idempotencyKey: { customerScope, idempotencyKey } },
    });
    if (!existing) {
      return this.claimWithAttempt(
        customerScope,
        idempotencyKey,
        requestHash,
        resolvedBookingLegId,
        attempt + 1,
      );
    }
    if (existing.requestHash !== requestHash) {
      throw new ExtensionIdempotencyKeyReusedException();
    }
    if (existing.state === ExtensionCreationIdempotencyState.COMPLETED) {
      return { kind: "replay", response: this.parseResponse(existing.response) };
    }
    if (existing.response !== null) {
      return this.finalizeCheckpointedResponse(existing.id, existing.response);
    }

    const leaseExpired =
      existing.updatedAt.getTime() <= Date.now() - EXTENSION_IDEMPOTENCY_PROCESSING_LEASE_MS;
    if (!leaseExpired) {
      throw new ExtensionRequestInProgressException(EXTENSION_IDEMPOTENCY_RETRY_AFTER_SECONDS);
    }

    if (existing.extensionId) {
      const claimed = await this.databaseService.extensionCreationIdempotency.updateMany({
        where: {
          id: existing.id,
          state: ExtensionCreationIdempotencyState.PROCESSING,
          updatedAt: existing.updatedAt,
        },
        data: { updatedAt: new Date() },
      });
      if (claimed.count === 1) {
        return { kind: "resume", id: existing.id, extensionId: existing.extensionId };
      }
    } else {
      const released = await this.databaseService.extensionCreationIdempotency.deleteMany({
        where: {
          id: existing.id,
          extensionId: null,
          state: ExtensionCreationIdempotencyState.PROCESSING,
          updatedAt: existing.updatedAt,
        },
      });
      if (released.count === 1) {
        return this.claimWithAttempt(
          customerScope,
          idempotencyKey,
          requestHash,
          resolvedBookingLegId,
          attempt + 1,
        );
      }
    }

    throw new ExtensionRequestInProgressException(EXTENSION_IDEMPOTENCY_RETRY_AFTER_SECONDS);
  }

  private async finalizeCheckpointedResponse(
    idempotencyId: string,
    response: Prisma.JsonValue,
  ): Promise<ExtensionIdempotencyClaim> {
    const finalized = await this.databaseService.extensionCreationIdempotency.updateMany({
      where: {
        id: idempotencyId,
        state: ExtensionCreationIdempotencyState.PROCESSING,
        extensionId: { not: null },
      },
      data: { state: ExtensionCreationIdempotencyState.COMPLETED },
    });
    if (finalized.count === 1) {
      return { kind: "replay", response: this.parseResponse(response) };
    }
    throw new ExtensionRequestInProgressException(EXTENSION_IDEMPOTENCY_RETRY_AFTER_SECONDS);
  }

  async attachExtension(
    tx: Prisma.TransactionClient,
    idempotencyId: string,
    extensionId: string,
  ): Promise<void> {
    const attached = await tx.extensionCreationIdempotency.updateMany({
      where: {
        id: idempotencyId,
        state: ExtensionCreationIdempotencyState.PROCESSING,
        extensionId: null,
      },
      data: { extensionId },
    });
    if (attached.count !== 1) {
      throw new ExtensionCreationFailedException("Extension idempotency claim was lost.");
    }
  }

  async checkpointResponse(
    idempotencyId: string,
    extensionId: string,
    response: CreateExtensionResponse,
  ): Promise<void> {
    const checkpointed = await this.databaseService.extensionCreationIdempotency.updateMany({
      where: {
        id: idempotencyId,
        extensionId,
        state: ExtensionCreationIdempotencyState.PROCESSING,
      },
      data: { response: response as unknown as Prisma.InputJsonValue },
    });
    if (checkpointed.count !== 1) {
      throw new ExtensionCreationFailedException("Extension payment checkpoint was lost.");
    }
  }

  async complete(idempotencyId: string): Promise<void> {
    const completed = await this.databaseService.extensionCreationIdempotency.updateMany({
      where: {
        id: idempotencyId,
        state: ExtensionCreationIdempotencyState.PROCESSING,
        response: { not: Prisma.DbNull },
      },
      data: { state: ExtensionCreationIdempotencyState.COMPLETED },
    });
    if (completed.count === 1) return;

    const existing = await this.databaseService.extensionCreationIdempotency.findUnique({
      where: { id: idempotencyId },
      select: { state: true, response: true },
    });
    if (
      existing?.state !== ExtensionCreationIdempotencyState.COMPLETED ||
      existing.response === null
    ) {
      throw new ExtensionCreationFailedException(
        "Extension payment checkpoint could not be completed.",
      );
    }
  }

  async release(idempotencyId: string): Promise<void> {
    try {
      await this.databaseService.extensionCreationIdempotency.deleteMany({
        where: {
          id: idempotencyId,
          extensionId: null,
          state: ExtensionCreationIdempotencyState.PROCESSING,
        },
      });
    } catch (error) {
      this.logger.error(
        {
          idempotencyId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to release pre-side-effect extension idempotency claim",
      );
    }
  }

  @Cron("15 3 * * *")
  async cleanupExpiredRecords(): Promise<number> {
    const staleBefore = new Date(Date.now() - EXTENSION_IDEMPOTENCY_RETENTION_MS);
    const result = await this.databaseService.extensionCreationIdempotency.deleteMany({
      where: {
        OR: [
          {
            state: ExtensionCreationIdempotencyState.COMPLETED,
            updatedAt: { lt: staleBefore },
          },
          {
            state: ExtensionCreationIdempotencyState.PROCESSING,
            extensionId: null,
            updatedAt: { lt: staleBefore },
          },
          {
            state: ExtensionCreationIdempotencyState.PROCESSING,
            extensionId: { not: null },
            updatedAt: { lt: staleBefore },
            extension: {
              is: {
                status: { in: ["ACTIVE", "CANCELLED", "REJECTED"] },
              },
            },
          },
        ],
      },
    });
    if (result.count > 0) {
      this.logger.info({ count: result.count }, "Deleted expired extension idempotency records");
    }
    return result.count;
  }

  private parseResponse(value: Prisma.JsonValue | null): CreateExtensionResponse {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      typeof value.extensionId !== "string" ||
      typeof value.paymentIntentId !== "string" ||
      typeof value.checkoutUrl !== "string"
    ) {
      throw new ExtensionCreationFailedException("Stored extension response is invalid.");
    }
    return {
      extensionId: value.extensionId,
      paymentIntentId: value.paymentIntentId,
      checkoutUrl: value.checkoutUrl,
    };
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
  }
}
