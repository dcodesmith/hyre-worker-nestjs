import { Test, TestingModule } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WHATSAPP_SEARCH_SLOT_TTL_SECONDS } from "./whatsapp-agent.const";
import { WhatsAppSlotMemoryPersistFailedException } from "./whatsapp-agent.error";
import { WHATSAPP_REDIS_CLIENT } from "./whatsapp-agent.tokens";
import { WhatsAppSearchSlotMemoryService } from "./whatsapp-search-slot-memory.service";

describe("WhatsAppSearchSlotMemoryService", () => {
  let moduleRef: TestingModule;
  let service: WhatsAppSearchSlotMemoryService;
  let redisMock: {
    get: ReturnType<typeof vi.fn>;
    eval: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
    quit: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    redisMock = {
      get: vi.fn(),
      eval: vi.fn(),
      set: vi.fn(),
      del: vi.fn(),
      quit: vi.fn().mockResolvedValue("OK"),
    };
    moduleRef = await Test.createTestingModule({
      providers: [
        WhatsAppSearchSlotMemoryService,
        {
          provide: WHATSAPP_REDIS_CLIENT,
          useValue: redisMock,
        },
      ],
    }).compile();
    service = moduleRef.get(WhatsAppSearchSlotMemoryService);
  });

  afterEach(async () => {
    await moduleRef?.close();
    vi.resetAllMocks();
  });

  it("merges latest non-empty fields with previous slot payload", async () => {
    redisMock.get.mockResolvedValue(
      JSON.stringify({
        extracted: { make: "Toyota", model: "Prado", color: "Black" },
        dialogState: {
          bookingTypeConfirmed: false,
          lastAskedQuestionType: null,
          lastAskedAt: null,
        },
        updatedAt: new Date().toISOString(),
      }),
    );
    redisMock.eval.mockResolvedValue(1);

    const merged = await service.mergeWithLatest("conv_1", {
      from: "2026-03-10",
      to: "2026-03-12",
      model: "   ",
    });

    expect(merged.extracted).toEqual({
      make: "Toyota",
      model: "Prado",
      color: "Black",
      from: "2026-03-10",
      to: "2026-03-12",
    });
    expect(merged.dialogState.bookingTypeConfirmed).toBe(false);
    expect(redisMock.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "whatsapp:search-slots:conv_1",
      expect.any(String),
      expect.any(String),
      String(WHATSAPP_SEARCH_SLOT_TTL_SECONDS),
    );
  });

  it("returns latest payload when redis read fails", async () => {
    redisMock.get.mockRejectedValue(new Error("redis read error"));
    redisMock.eval.mockResolvedValue(1);

    const merged = await service.mergeWithLatest("conv_2", {
      vehicleType: "SUV",
      color: "White",
    });

    expect(merged.extracted).toEqual({ vehicleType: "SUV", color: "White" });
  });

  it("returns latest payload when redis payload is invalid json", async () => {
    redisMock.get.mockResolvedValue("not-json");
    redisMock.eval.mockResolvedValue(1);

    const merged = await service.mergeWithLatest("conv_json", {
      vehicleType: "SUV",
      color: "White",
    });

    expect(merged.extracted).toEqual({ vehicleType: "SUV", color: "White" });
    expect(redisMock.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "whatsapp:search-slots:conv_json",
      "not-json",
      expect.any(String),
      String(WHATSAPP_SEARCH_SLOT_TTL_SECONDS),
    );
  });

  it("rethrows when redis write fails during merge", async () => {
    redisMock.get.mockResolvedValue(null);
    redisMock.eval.mockRejectedValue(new Error("redis write error"));

    await expect(
      service.mergeWithLatest("conv_write_error", {
        vehicleType: "SUV",
      }),
    ).rejects.toThrow("redis write error");
  });

  it("throws slot memory persist failed when compare-and-set never persists", async () => {
    redisMock.get.mockResolvedValue(null);
    redisMock.eval.mockResolvedValue(0);

    await expect(
      service.mergeWithLatest("conv_cas", {
        vehicleType: "SUV",
      }),
    ).rejects.toBeInstanceOf(WhatsAppSlotMemoryPersistFailedException);
    expect(redisMock.eval).toHaveBeenCalledTimes(3);
  });

  it("clears stale model when latest message broadens to make plus vehicle type", async () => {
    redisMock.get.mockResolvedValue(
      JSON.stringify({
        extracted: {
          make: "Toyota",
          model: "Prado",
          color: "Black",
        },
        dialogState: {
          bookingTypeConfirmed: true,
          lastAskedQuestionType: "booking_clarification",
          lastAskedAt: "2026-03-10T09:00:00.000Z",
        },
        updatedAt: new Date().toISOString(),
      }),
    );
    redisMock.eval.mockResolvedValue(1);

    const merged = await service.mergeWithLatest("conv_4", {
      make: "Toyota",
      vehicleType: "SUV",
      color: "White",
    });

    expect(merged.extracted.model).toBeUndefined();
    expect(merged.extracted.vehicleType).toBe("SUV");
    expect(merged.dialogState.bookingTypeConfirmed).toBe(false);
  });

  it("swallows clear errors and does not throw", async () => {
    redisMock.del.mockRejectedValue(new Error("redis del error"));

    await expect(service.clear("conv_3")).resolves.toBeUndefined();
  });

  it("quits redis on module destroy", async () => {
    redisMock.quit.mockResolvedValue("OK");
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    expect(redisMock.quit).toHaveBeenCalledTimes(1);
  });

  it("swallows redis quit errors on module destroy", async () => {
    redisMock.quit.mockRejectedValue(new Error("quit failed"));
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
  });

  it("skips redis write for no-op dialog state updates", async () => {
    redisMock.get.mockResolvedValue(
      JSON.stringify({
        extracted: { make: "Toyota" },
        dialogState: {
          bookingTypeConfirmed: false,
          lastAskedQuestionType: null,
          lastAskedAt: null,
        },
        updatedAt: new Date().toISOString(),
      }),
    );

    await expect(service.clearAskedQuestion("conv_noop")).resolves.toBeUndefined();
    expect(redisMock.eval).not.toHaveBeenCalled();
  });
});
