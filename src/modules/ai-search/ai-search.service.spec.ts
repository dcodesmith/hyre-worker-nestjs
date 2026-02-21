import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiSearchFailedException, AiSearchTimeoutException } from "./ai-search.error";
import { AiSearchService } from "./ai-search.service";
import { OpenAiAiSearchExtractorService } from "./openai-ai-search-extractor.service";

describe("AiSearchService", () => {
  let service: AiSearchService;
  let extractorService: { extract: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    extractorService = {
      extract: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiSearchService,
        { provide: OpenAiAiSearchExtractorService, useValue: extractorService },
      ],
    }).compile();

    service = module.get<AiSearchService>(AiSearchService);
  });

  it("returns mapped params and interpretation", async () => {
    extractorService.extract.mockResolvedValue({
      color: "black",
      make: "Toyota",
      model: "Camry",
      serviceTier: "ULTRA_LUXURY",
      vehicleType: "LUXURY_SEDAN",
      bookingType: "DAY",
      from: "2026-03-01",
      to: "2026-03-02",
    });

    const result = await service.search("Need a black camry");

    expect(result.params).toEqual({
      color: "black",
      make: "Toyota",
      model: "Camry",
      serviceTier: "ULTRA_LUXURY",
      vehicleType: "LUXURY_SEDAN",
      bookingType: "DAY",
      from: "2026-03-01",
      to: "2026-03-02",
    });
    expect(result.interpretation).toContain("Looking for:");
    expect(result.interpretation).toContain("ultra luxury");
    expect(result.interpretation).toContain("luxury sedan");
    expect(result.interpretation).toContain("Dates: 2026-03-01 to 2026-03-02");
  });

  it("rethrows known ai search exceptions", async () => {
    extractorService.extract.mockRejectedValue(new AiSearchTimeoutException());

    await expect(service.search("any")).rejects.toBeInstanceOf(AiSearchTimeoutException);
  });

  it("throws generic ai search failed for unknown errors", async () => {
    extractorService.extract.mockRejectedValue(new Error("boom"));

    await expect(service.search("any")).rejects.toBeInstanceOf(AiSearchFailedException);
  });
});
