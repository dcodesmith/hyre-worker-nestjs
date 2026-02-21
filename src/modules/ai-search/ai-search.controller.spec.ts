import { Test, type TestingModule } from "@nestjs/testing";
import type { Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiSearchController } from "./ai-search.controller";
import { AiSearchService } from "./ai-search.service";

describe("AiSearchController", () => {
  let controller: AiSearchController;
  let aiSearchService: { search: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    aiSearchService = {
      search: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AiSearchController],
      providers: [{ provide: AiSearchService, useValue: aiSearchService }],
    }).compile();

    controller = module.get<AiSearchController>(AiSearchController);
  });

  it("sets no-store header and delegates search", async () => {
    aiSearchService.search.mockResolvedValue({
      params: { make: "Toyota" },
      interpretation: "Looking for: toyota",
      raw: { make: "Toyota" },
    });

    const response = {
      setHeader: vi.fn(),
    } as unknown as Response;

    const result = await controller.search({ query: "toyota" }, response);

    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(aiSearchService.search).toHaveBeenCalledWith("toyota");
    expect(result.params.make).toBe("Toyota");
  });
});
