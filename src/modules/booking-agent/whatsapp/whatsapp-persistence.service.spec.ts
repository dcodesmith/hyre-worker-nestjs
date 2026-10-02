import { Test, type TestingModule } from "@nestjs/testing";
import { WhatsAppLinkStatus, WhatsAppMessageKind, WhatsAppOutboxStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { DatabaseService } from "../../database/database.service";
import { WHATSAPP_OUTBOX_PROCESSING_TTL_MS } from "../booking-agent.const";
import { WhatsAppPersistenceService } from "./whatsapp-persistence.service";

describe("WhatsAppPersistenceService", () => {
  let moduleRef: TestingModule;
  let service: WhatsAppPersistenceService;
  let databaseService: {
    whatsAppConversation: {
      updateMany: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
    };
    whatsAppMessage: {
      update: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };
    whatsAppOutbox: {
      updateMany: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
    };
    $transaction: ReturnType<typeof vi.fn>;
    $queryRaw: ReturnType<typeof vi.fn>;
    user: { findFirst: ReturnType<typeof vi.fn> };
  };

  beforeEach(async () => {
    databaseService = {
      whatsAppConversation: {
        updateMany: vi.fn(),
        update: vi.fn(),
        upsert: vi.fn(),
        findUnique: vi.fn(),
      },
      whatsAppMessage: {
        update: vi.fn(),
        findUnique: vi.fn(),
        create: vi.fn(),
        delete: vi.fn(),
      },
      whatsAppOutbox: {
        updateMany: vi.fn(),
        update: vi.fn(),
        create: vi.fn(),
        delete: vi.fn(),
        findUnique: vi.fn(),
      },
      $transaction: vi.fn(async (callback: (tx: typeof databaseService) => unknown) =>
        callback(databaseService),
      ),
      $queryRaw: vi.fn().mockResolvedValue([{ id: "conv-1" }]),
      user: { findFirst: vi.fn().mockResolvedValue(null) },
    };

    moduleRef = await Test.createTestingModule({
      providers: [
        WhatsAppPersistenceService,
        {
          provide: DatabaseService,
          useValue: databaseService,
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = moduleRef.get(WhatsAppPersistenceService);
  });

  it("acquires a processing lock when update count is one", async () => {
    databaseService.whatsAppConversation.updateMany.mockResolvedValue({ count: 1 });

    await expect(service.acquireProcessingLock("conv-1", "token-1")).resolves.toBe(true);
    expect(databaseService.whatsAppConversation.updateMany).toHaveBeenCalledTimes(1);
  });

  it("returns null inbound context for non-inbound messages", async () => {
    databaseService.whatsAppMessage.findUnique.mockResolvedValue({
      id: "msg-1",
      direction: "OUTBOUND",
    });

    await expect(service.getInboundMessageContext("msg-1")).resolves.toBeNull();
  });

  it("returns null inbound context when the message is already processed", async () => {
    databaseService.whatsAppMessage.findUnique.mockResolvedValue({
      id: "msg-1",
      direction: "INBOUND",
      status: "PROCESSED",
      body: "book me an suv",
    });

    await expect(service.getInboundMessageContext("msg-1")).resolves.toBeNull();
  });

  it("reactivates CLOSED conversations and does not force ACTIVE on upsert", async () => {
    const now = new Date("2026-03-01T00:00:00.000Z");
    const windowExpiresAt = new Date("2026-03-02T00:00:00.000Z");
    databaseService.whatsAppConversation.upsert.mockResolvedValue({ id: "conv-1" });
    databaseService.whatsAppConversation.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      service.upsertConversationForInbound({
        phoneE164: "+2348000000000",
        payload: { WaId: "2348000000000", ProfileName: "Ada" },
        now,
        windowExpiresAt,
      }),
    ).resolves.toEqual({ id: "conv-1" });

    const upsertArgs = databaseService.whatsAppConversation.upsert.mock.calls[0]?.[0];
    expect(upsertArgs.create).not.toHaveProperty("status");
    expect(upsertArgs.update).not.toHaveProperty("status");
    expect(upsertArgs.update).toEqual(
      expect.objectContaining({
        lastInboundAt: now,
        windowExpiresAt,
      }),
    );
    expect(databaseService.whatsAppConversation.updateMany).toHaveBeenCalledWith({
      where: {
        id: "conv-1",
        status: "CLOSED",
      },
      data: { status: "ACTIVE" },
    });
  });

  describe("synchronizeConversationIdentity", () => {
    const conversationId = "018f47a2-7b3c-7d4e-8f90-1234567894a1";

    it("links a verified phone and clears state before the database update", async () => {
      const order: string[] = [];
      databaseService.whatsAppConversation.findUnique.mockResolvedValue({
        phoneE164: "+2348012345678",
        linkedUserId: null,
        linkStatus: WhatsAppLinkStatus.UNLINKED,
      });
      databaseService.user.findFirst.mockResolvedValue({ id: "user-verified" });
      databaseService.whatsAppConversation.update.mockImplementation(async () => {
        order.push("update");
        return { id: conversationId };
      });

      await service.synchronizeConversationIdentity(conversationId, async () => {
        order.push("clear");
      });

      expect(order).toEqual(["clear", "update"]);
      expect(databaseService.$queryRaw).toHaveBeenCalled();
      expect(databaseService.user.findFirst).toHaveBeenCalledWith({
        where: {
          phoneNumber: "+2348012345678",
          phoneVerifiedAt: { not: null },
        },
        select: { id: true },
      });
      expect(databaseService.whatsAppConversation.update).toHaveBeenCalledWith({
        where: { id: conversationId },
        data: {
          linkedUserId: "user-verified",
          linkStatus: WhatsAppLinkStatus.LINKED,
          linkVerifiedAt: expect.any(Date),
        },
      });
    });

    it("unlinks a conversation when the phone is no longer verified", async () => {
      databaseService.whatsAppConversation.findUnique.mockResolvedValue({
        phoneE164: "+2348012345678",
        linkedUserId: "user-old",
        linkStatus: WhatsAppLinkStatus.LINKED,
      });
      databaseService.user.findFirst.mockResolvedValue(null);
      const clearState = vi.fn().mockResolvedValue(undefined);

      await service.synchronizeConversationIdentity(conversationId, clearState);

      expect(clearState).toHaveBeenCalledOnce();
      expect(databaseService.whatsAppConversation.update).toHaveBeenCalledWith({
        where: { id: conversationId },
        data: {
          linkedUserId: null,
          linkStatus: WhatsAppLinkStatus.UNLINKED,
          linkVerifiedAt: null,
        },
      });
    });

    it("relinks a conversation when a different verified user owns the phone", async () => {
      databaseService.whatsAppConversation.findUnique.mockResolvedValue({
        phoneE164: "+2348012345678",
        linkedUserId: "user-old",
        linkStatus: WhatsAppLinkStatus.LINKED,
      });
      databaseService.user.findFirst.mockResolvedValue({ id: "user-new" });
      const clearState = vi.fn().mockResolvedValue(undefined);

      await service.synchronizeConversationIdentity(conversationId, clearState);

      expect(clearState).toHaveBeenCalledBefore(databaseService.whatsAppConversation.update);
      expect(databaseService.whatsAppConversation.update).toHaveBeenCalledWith({
        where: { id: conversationId },
        data: expect.objectContaining({
          linkedUserId: "user-new",
          linkStatus: WhatsAppLinkStatus.LINKED,
        }),
      });
    });

    it("does nothing when the conversation row is missing", async () => {
      databaseService.whatsAppConversation.findUnique.mockResolvedValue(null);
      const clearState = vi.fn();

      await service.synchronizeConversationIdentity(conversationId, clearState);

      expect(clearState).not.toHaveBeenCalled();
      expect(databaseService.whatsAppConversation.update).not.toHaveBeenCalled();
    });

    it("leaves a revoked conversation unchanged", async () => {
      databaseService.whatsAppConversation.findUnique.mockResolvedValue({
        phoneE164: "+2348012345678",
        linkedUserId: "user-old",
        linkStatus: WhatsAppLinkStatus.REVOKED,
      });
      const clearState = vi.fn();

      await service.synchronizeConversationIdentity(conversationId, clearState);

      expect(clearState).not.toHaveBeenCalled();
      expect(databaseService.user.findFirst).not.toHaveBeenCalled();
      expect(databaseService.whatsAppConversation.update).not.toHaveBeenCalled();
    });

    it("does not clear state when the linked identity is already current", async () => {
      databaseService.whatsAppConversation.findUnique.mockResolvedValue({
        phoneE164: "+2348012345678",
        linkedUserId: "user-verified",
        linkStatus: WhatsAppLinkStatus.LINKED,
      });
      databaseService.user.findFirst.mockResolvedValue({ id: "user-verified" });
      const clearState = vi.fn();

      await service.synchronizeConversationIdentity(conversationId, clearState);

      expect(clearState).not.toHaveBeenCalled();
      expect(databaseService.whatsAppConversation.update).not.toHaveBeenCalled();
    });

    it("does not update the conversation when clearing state fails", async () => {
      databaseService.whatsAppConversation.findUnique.mockResolvedValue({
        phoneE164: "+2348012345678",
        linkedUserId: null,
        linkStatus: WhatsAppLinkStatus.UNLINKED,
      });
      databaseService.user.findFirst.mockResolvedValue({ id: "user-verified" });
      const clearError = new Error("redis unavailable");

      await expect(
        service.synchronizeConversationIdentity(conversationId, async () => {
          throw clearError;
        }),
      ).rejects.toBe(clearError);
      expect(databaseService.whatsAppConversation.update).not.toHaveBeenCalled();
    });
  });

  it("returns null link state when conversation is missing", async () => {
    databaseService.whatsAppConversation.findUnique.mockResolvedValue(null);

    await expect(service.getConversationLinkState("conv-missing")).resolves.toEqual({
      linkedUserId: null,
      linkStatus: null,
    });
  });

  it("claims outbox atomically via updateMany", async () => {
    databaseService.whatsAppOutbox.updateMany.mockResolvedValue({ count: 1 });

    await expect(service.claimOutboxForProcessing("outbox-1", new Date())).resolves.toBe(true);
    expect(databaseService.whatsAppOutbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "outbox-1",
          providerMessageSid: null,
          OR: expect.any(Array),
        }),
      }),
    );
  });

  it("reclaims PROCESSING outbox rows only after the processing TTL", async () => {
    const now = new Date("2026-03-01T00:01:00.000Z");
    const staleProcessingBefore = new Date(now.getTime() - WHATSAPP_OUTBOX_PROCESSING_TTL_MS);
    databaseService.whatsAppOutbox.updateMany.mockResolvedValue({ count: 1 });

    await expect(service.claimOutboxForProcessing("outbox-1", now)).resolves.toBe(true);

    expect(databaseService.whatsAppOutbox.updateMany).toHaveBeenCalledWith({
      where: {
        id: "outbox-1",
        providerMessageSid: null,
        OR: [
          { status: WhatsAppOutboxStatus.PENDING },
          { status: WhatsAppOutboxStatus.FAILED, nextAttemptAt: { lte: now } },
          {
            status: WhatsAppOutboxStatus.PROCESSING,
            lastAttemptAt: { lte: staleProcessingBefore },
          },
        ],
      },
      data: {
        status: WhatsAppOutboxStatus.PROCESSING,
        attempts: { increment: 1 },
        lastAttemptAt: now,
      },
    });
  });

  it("marks outbox failure and truncates long error message", async () => {
    databaseService.whatsAppOutbox.update.mockResolvedValue({});
    const longMessage = "x".repeat(700);

    await service.markOutboxFailed(
      "outbox-1",
      WhatsAppOutboxStatus.FAILED,
      longMessage,
      new Date("2026-03-01T00:00:00.000Z"),
    );

    expect(databaseService.whatsAppOutbox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "outbox-1" },
        data: expect.objectContaining({
          status: WhatsAppOutboxStatus.FAILED,
          failureReason: "x".repeat(500),
        }),
      }),
    );
  });

  it("marks outbox sent with non-null nextAttemptAt", async () => {
    const sentAt = new Date("2026-03-02T10:00:00.000Z");
    const tx = {
      whatsAppOutbox: { update: vi.fn().mockResolvedValue({}) },
      whatsAppConversation: { update: vi.fn().mockResolvedValue({}) },
      whatsAppMessage: { create: vi.fn().mockResolvedValue({}) },
    };
    databaseService.$transaction.mockImplementation(async (callback) => callback(tx));

    await service.markOutboxSent({
      outboxId: "outbox-1",
      conversationId: "conv-1",
      textBody: "hello",
      mediaUrl: null,
      kind: WhatsAppMessageKind.TEXT,
      providerMessage: {
        sid: "SM123",
        status: "queued",
        errorCode: null,
        errorMessage: null,
        dateCreated: sentAt,
        dateUpdated: sentAt,
      } as never,
      sentAt,
    });

    expect(tx.whatsAppOutbox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "outbox-1" },
        data: expect.objectContaining({
          status: WhatsAppOutboxStatus.SENT,
          providerMessageSid: "SM123",
          sentAt,
          nextAttemptAt: sentAt,
        }),
      }),
    );
    expect(tx.whatsAppMessage.create.mock.calls[0]?.[0].data).not.toHaveProperty("id");
  });
});
