import { Test, type TestingModule } from "@nestjs/testing";
import { WhatsAppOutboxStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseService } from "../../database/database.service";
import { WhatsAppPersistenceService } from "./whatsapp-persistence.service";

describe("WhatsAppPersistenceService", () => {
  let moduleRef: TestingModule;
  let service: WhatsAppPersistenceService;
  let databaseService: {
    whatsAppConversation: {
      updateMany: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
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
  };

  beforeEach(async () => {
    databaseService = {
      whatsAppConversation: {
        updateMany: vi.fn(),
        update: vi.fn(),
        upsert: vi.fn(),
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
      $transaction: vi.fn(),
    };

    moduleRef = await Test.createTestingModule({
      providers: [
        WhatsAppPersistenceService,
        {
          provide: DatabaseService,
          useValue: databaseService,
        },
      ],
    }).compile();

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
});
