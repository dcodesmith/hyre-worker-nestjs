import { Test, TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WHATSAPP_SEARCH_SLOT_TTL_SECONDS } from "./whatsapp-agent.const";
import { WHATSAPP_REDIS_CLIENT } from "./whatsapp-agent.tokens";
import { WhatsAppSearchSlotMemoryService } from "./whatsapp-search-slot-memory.service";

describe("WhatsAppSearchSlotMemoryService", () => {
  let moduleRef: TestingModule;
  let service: WhatsAppSearchSlotMemoryService;
  let redisMock: {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
    quit: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    redisMock = {
      get: vi.fn(),
      set: vi.fn(),
      del: vi.fn(),
      quit: vi.fn(),
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

  it("merges latest non-empty fields with previous slot payload", async () => {
    redisMock.get.mockResolvedValue(
      JSON.stringify({
        extracted: { make: "Toyota", model: "Prado", color: "Black" },
      }),
    );
    redisMock.set.mockResolvedValue("OK");

    const merged = await service.mergeWithLatest("conv_1", {
      from: "2026-03-10",
      to: "2026-03-12",
      model: "   ",
    });

    expect(merged).toEqual({
      make: "Toyota",
      model: "Prado",
      color: "Black",
      from: "2026-03-10",
      to: "2026-03-12",
    });
    expect(redisMock.set).toHaveBeenCalledWith(
      "whatsapp:search-slots:conv_1",
      expect.any(String),
      "EX",
      WHATSAPP_SEARCH_SLOT_TTL_SECONDS,
    );
  });

  it("returns latest payload when redis read fails", async () => {
    redisMock.get.mockRejectedValue(new Error("redis read error"));
    redisMock.set.mockResolvedValue("OK");

    const merged = await service.mergeWithLatest("conv_2", {
      vehicleType: "SUV",
      color: "White",
    });

    expect(merged).toEqual({ vehicleType: "SUV", color: "White" });
  });

  it("returns latest payload when redis payload is invalid json", async () => {
    redisMock.get.mockResolvedValue("not-json");
    redisMock.set.mockResolvedValue("OK");

    const merged = await service.mergeWithLatest("conv_json", {
      vehicleType: "SUV",
      color: "White",
    });

    expect(merged).toEqual({ vehicleType: "SUV", color: "White" });
    expect(redisMock.set).toHaveBeenCalledWith(
      "whatsapp:search-slots:conv_json",
      expect.any(String),
      "EX",
      WHATSAPP_SEARCH_SLOT_TTL_SECONDS,
    );
  });

  it("rethrows when redis write fails during merge", async () => {
    redisMock.get.mockResolvedValue(null);
    redisMock.set.mockRejectedValue(new Error("redis write error"));

    await expect(
      service.mergeWithLatest("conv_write_error", {
        vehicleType: "SUV",
      }),
    ).rejects.toThrow("redis write error");
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
});
