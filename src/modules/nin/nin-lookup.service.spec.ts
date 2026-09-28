import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MonoNinResult } from "../mono/mono.interface";
import { MonoError, MonoService } from "../mono/mono.service";
import { PremblyError, PremblyService } from "../prembly/prembly.service";
import { NinLookupService } from "./nin-lookup.service";

const identity: MonoNinResult = {
  firstName: "ADA",
  middleName: null,
  lastName: "LOVELACE",
  dateOfBirth: new Date(Date.UTC(1990, 0, 1)),
  officialPhoto: "photo",
  reference: "nin-ref",
};

describe("NinLookupService", () => {
  let service: NinLookupService;
  let monoService: { verifyNin: ReturnType<typeof vi.fn> };
  let premblyService: { verifyNin: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    monoService = { verifyNin: vi.fn() };
    premblyService = { verifyNin: vi.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NinLookupService,
        { provide: MonoService, useValue: monoService },
        { provide: PremblyService, useValue: premblyService },
      ],
    }).compile();
    service = module.get(NinLookupService);
  });

  it("returns a Mono NIN result without calling Prembly", async () => {
    monoService.verifyNin.mockResolvedValueOnce(identity);

    await expect(service.lookup("12345678901")).resolves.toBe(identity);
    expect(premblyService.verifyNin).not.toHaveBeenCalled();
  });

  it.each(["UNAVAILABLE", "INVALID_RESPONSE"] as const)(
    "falls back to Prembly when Mono is %s",
    async (kind) => {
      monoService.verifyNin.mockRejectedValueOnce(new MonoError(kind));
      premblyService.verifyNin.mockResolvedValueOnce({ ...identity, reference: "prembly-ref" });

      await expect(service.lookup("12345678901")).resolves.toMatchObject({
        reference: "prembly-ref",
      });
      expect(premblyService.verifyNin).toHaveBeenCalledWith("12345678901");
    },
  );

  it("does not fall back when Mono rejects the NIN", async () => {
    monoService.verifyNin.mockRejectedValueOnce(new MonoError("REJECTED"));

    await expect(service.lookup("12345678901")).rejects.toEqual(new MonoError("REJECTED"));
    expect(premblyService.verifyNin).not.toHaveBeenCalled();
  });

  it("propagates a Prembly rejection after an allowed fallback", async () => {
    monoService.verifyNin.mockRejectedValueOnce(new MonoError("UNAVAILABLE"));
    premblyService.verifyNin.mockRejectedValueOnce(new PremblyError("REJECTED"));

    await expect(service.lookup("12345678901")).rejects.toEqual(new PremblyError("REJECTED"));
  });
});
