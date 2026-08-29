import { Test, type TestingModule } from "@nestjs/testing";
import { ExtensionCreationIdempotencyState, Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { DatabaseService } from "../database/database.service";
import {
  ExtensionIdempotencyKeyReusedException,
  ExtensionRequestInProgressException,
} from "./booking.error";
import {
  ExtensionCreationIdempotencyService,
  type ExtensionIdempotencyRequest,
} from "./extension-creation-idempotency.service";

const request: ExtensionIdempotencyRequest = {
  bookingId: "booking-1",
  bookingLegId: "leg-1",
  hours: 2,
  callbackUrl: "https://example.com/callback",
};

const response = {
  extensionId: "extension-1",
  paymentIntentId: "ext-idem-1",
  checkoutUrl: "https://checkout.example/ext-idem-1",
};

const record = (overrides: Record<string, unknown> = {}) => ({
  id: "idem-1",
  customerScope: "user:user-1",
  idempotencyKey: "extension-request-1",
  requestHash: "hash-1",
  resolvedBookingLegId: "leg-1",
  state: ExtensionCreationIdempotencyState.PROCESSING,
  extensionId: null,
  response: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

function duplicateKeyError() {
  return new Prisma.PrismaClientKnownRequestError("duplicate", {
    code: "P2002",
    clientVersion: "test",
  });
}

describe("ExtensionCreationIdempotencyService", () => {
  let service: ExtensionCreationIdempotencyService;
  let databaseService: {
    extensionCreationIdempotency: {
      create: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
      deleteMany: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    databaseService = {
      extensionCreationIdempotency: {
        create: vi.fn(),
        findUnique: vi.fn(),
        updateMany: vi.fn(),
        deleteMany: vi.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExtensionCreationIdempotencyService,
        { provide: DatabaseService, useValue: databaseService },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get(ExtensionCreationIdempotencyService);
  });

  it("hashes the resolved leg and all payment request values deterministically", () => {
    const reordered = {
      callbackUrl: request.callbackUrl,
      hours: request.hours,
      bookingLegId: request.bookingLegId,
      bookingId: request.bookingId,
    };

    expect(service.createRequestHash(request)).toBe(service.createRequestHash(reordered));
    expect(service.createRequestHash(request)).not.toBe(
      service.createRequestHash({ ...request, hours: 3 }),
    );
    expect(service.createRequestHash(request)).not.toBe(
      service.createRequestHash({ ...request, bookingId: "booking-2" }),
    );
    expect(service.createRequestHash(request)).not.toBe(
      service.createRequestHash({ ...request, bookingLegId: "leg-2" }),
    );
    expect(service.createRequestHash(request)).not.toBe(
      service.createRequestHash({ ...request, callbackUrl: "https://example.com/other" }),
    );
    expect(service.getCustomerScope("user-1")).toBe("user:user-1");
  });

  it("creates a stable provider reference from the persisted claim", () => {
    expect(service.createPaymentIntentReference("idem-1")).toBe("ext-idem-1");
  });

  it("reuses the leg resolved by an earlier request with the same key", async () => {
    databaseService.extensionCreationIdempotency.findUnique.mockResolvedValue({
      resolvedBookingLegId: "leg-original",
    });

    await expect(
      service.findResolvedBookingLegId("user:user-1", "extension-request-1"),
    ).resolves.toBe("leg-original");
  });

  it("claims a new user-scoped idempotency key", async () => {
    databaseService.extensionCreationIdempotency.create.mockResolvedValue({ id: "idem-1" });

    await expect(
      service.claim("user:user-1", "extension-request-1", "hash-1", "leg-1"),
    ).resolves.toEqual({
      kind: "claimed",
      id: "idem-1",
    });
    expect(databaseService.extensionCreationIdempotency.create).toHaveBeenCalledWith({
      data: {
        customerScope: "user:user-1",
        idempotencyKey: "extension-request-1",
        requestHash: "hash-1",
        resolvedBookingLegId: "leg-1",
      },
      select: { id: true },
    });
  });

  it("replays the completed response for an identical request", async () => {
    databaseService.extensionCreationIdempotency.create.mockRejectedValue(duplicateKeyError());
    databaseService.extensionCreationIdempotency.findUnique.mockResolvedValue(
      record({
        state: ExtensionCreationIdempotencyState.COMPLETED,
        extensionId: "extension-1",
        response,
      }),
    );

    await expect(
      service.claim("user:user-1", "extension-request-1", "hash-1", "leg-1"),
    ).resolves.toEqual({
      kind: "replay",
      response,
    });
  });

  it("rejects changed request values with the same key", async () => {
    databaseService.extensionCreationIdempotency.create.mockRejectedValue(duplicateKeyError());
    databaseService.extensionCreationIdempotency.findUnique.mockResolvedValue(record());

    await expect(
      service.claim("user:user-1", "extension-request-1", "different-hash", "leg-1"),
    ).rejects.toBeInstanceOf(ExtensionIdempotencyKeyReusedException);
  });

  it("returns an in-progress conflict for a concurrent identical request", async () => {
    databaseService.extensionCreationIdempotency.create.mockRejectedValue(duplicateKeyError());
    databaseService.extensionCreationIdempotency.findUnique.mockResolvedValue(record());

    await expect(
      service.claim("user:user-1", "extension-request-1", "hash-1", "leg-1"),
    ).rejects.toBeInstanceOf(ExtensionRequestInProgressException);
  });

  it("leases a stale attached claim so the deterministic provider request can resume", async () => {
    const updatedAt = new Date(Date.now() - 2 * 60 * 1000);
    databaseService.extensionCreationIdempotency.create.mockRejectedValue(duplicateKeyError());
    databaseService.extensionCreationIdempotency.findUnique.mockResolvedValue(
      record({ extensionId: "extension-1", updatedAt }),
    );
    databaseService.extensionCreationIdempotency.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      service.claim("user:user-1", "extension-request-1", "hash-1", "leg-1"),
    ).resolves.toEqual({
      kind: "resume",
      id: "idem-1",
      extensionId: "extension-1",
    });
    expect(databaseService.extensionCreationIdempotency.updateMany).toHaveBeenCalledWith({
      where: {
        id: "idem-1",
        state: ExtensionCreationIdempotencyState.PROCESSING,
        updatedAt,
      },
      data: { updatedAt: expect.any(Date) },
    });
  });

  it("finalizes and replays a checkpointed response", async () => {
    databaseService.extensionCreationIdempotency.create.mockRejectedValue(duplicateKeyError());
    databaseService.extensionCreationIdempotency.findUnique.mockResolvedValue(
      record({ extensionId: "extension-1", response }),
    );
    databaseService.extensionCreationIdempotency.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      service.claim("user:user-1", "extension-request-1", "hash-1", "leg-1"),
    ).resolves.toEqual({
      kind: "replay",
      response,
    });
  });

  it("attaches the extension before the provider call can start", async () => {
    databaseService.extensionCreationIdempotency.updateMany.mockResolvedValue({ count: 1 });

    await service.attachExtension(databaseService as never, "idem-1", "extension-1");

    expect(databaseService.extensionCreationIdempotency.updateMany).toHaveBeenCalledWith({
      where: {
        id: "idem-1",
        state: ExtensionCreationIdempotencyState.PROCESSING,
        extensionId: null,
      },
      data: { extensionId: "extension-1" },
    });
  });

  it("checkpoints the original checkout response before completion", async () => {
    databaseService.extensionCreationIdempotency.updateMany.mockResolvedValue({ count: 1 });

    await service.checkpointResponse("idem-1", "extension-1", response);
    await service.complete("idem-1");

    expect(databaseService.extensionCreationIdempotency.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: "idem-1",
        extensionId: "extension-1",
        state: ExtensionCreationIdempotencyState.PROCESSING,
      },
      data: { response },
    });
    expect(databaseService.extensionCreationIdempotency.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({ id: "idem-1" }),
        data: { state: ExtensionCreationIdempotencyState.COMPLETED },
      }),
    );
  });

  it("releases only a claim that has not created an extension", async () => {
    databaseService.extensionCreationIdempotency.deleteMany.mockResolvedValue({ count: 1 });

    await service.release("idem-1");

    expect(databaseService.extensionCreationIdempotency.deleteMany).toHaveBeenCalledWith({
      where: {
        id: "idem-1",
        extensionId: null,
        state: ExtensionCreationIdempotencyState.PROCESSING,
      },
    });
  });

  it("cleans up stale attached claims after the extension reaches a terminal state", async () => {
    databaseService.extensionCreationIdempotency.deleteMany.mockResolvedValue({ count: 1 });

    await expect(service.cleanupExpiredRecords()).resolves.toBe(1);

    expect(databaseService.extensionCreationIdempotency.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: expect.arrayContaining([
          expect.objectContaining({
            state: ExtensionCreationIdempotencyState.PROCESSING,
            extensionId: { not: null },
            extension: {
              is: {
                status: { in: ["ACTIVE", "CANCELLED", "REJECTED"] },
              },
            },
          }),
        ]),
      },
    });
  });
});
