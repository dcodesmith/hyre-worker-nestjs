import { ConfigService } from "@nestjs/config";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WHATSAPP_SEARCH_SLOT_TTL_SECONDS } from "./whatsapp-agent.const";
import { WhatsAppSearchSlotMemoryService } from "./whatsapp-search-slot-memory.service";

const { redisMock } = vi.hoisted(() => ({
  redisMock: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    quit: vi.fn(),
  },
}));

vi.mock("ioredis", () => ({
  default: vi.fn().mockImplementation(() => redisMock),
}));

describe("WhatsAppSearchSlotMemoryService", () => {
  let service: WhatsAppSearchSlotMemoryService;

  beforeEach(() => {
    vi.clearAllMocks();
    const configService = {
      get: vi.fn().mockReturnValue("redis://localhost:6379"),
    } as unknown as ConfigService;
    service = new WhatsAppSearchSlotMemoryService(configService);
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

  it("swallows clear errors and does not throw", async () => {
    redisMock.del.mockRejectedValue(new Error("redis del error"));

    await expect(service.clear("conv_3")).resolves.toBeUndefined();
  });
});
