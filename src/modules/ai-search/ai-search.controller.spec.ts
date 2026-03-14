import { GUARDS_METADATA } from "@nestjs/common/constants";
import { Test, type TestingModule } from "@nestjs/testing";
import { ThrottlerModule } from "@nestjs/throttler";
import type { Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiSearchController } from "./ai-search.controller";
import { AiSearchService } from "./ai-search.service";
import { AiSearchThrottlerGuard } from "./ai-search-throttler.guard";
import { AI_SEARCH_THROTTLE_CONFIG } from "./ai-search-throttling.config";

describe("AiSearchController", () => {
  let controller: AiSearchController;
  let aiSearchService: { search: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    aiSearchService = {
      search: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([
          {
            name: AI_SEARCH_THROTTLE_CONFIG.name,
            ttl: AI_SEARCH_THROTTLE_CONFIG.ttlMs,
            limit: AI_SEARCH_THROTTLE_CONFIG.limit,
          },
        ]),
      ],
      controllers: [AiSearchController],
      providers: [AiSearchThrottlerGuard, { provide: AiSearchService, useValue: aiSearchService }],
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

  it("applies AiSearchThrottlerGuard on search endpoint", () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      AiSearchController.prototype.search,
    ) as unknown[];
    expect(guards).toContain(AiSearchThrottlerGuard);
  });
});
