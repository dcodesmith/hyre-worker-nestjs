import { HEADERS_METADATA } from "@nestjs/common/constants";
import { Test, type TestingModule } from "@nestjs/testing";
import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AnalyticsChannel } from "../analytics/analytics-event.schema";
import { CarController } from "./car.controller";
import { CarCategoriesService } from "./car-categories.service";
import { CarSearchService } from "./car-search.service";
import type { CarSearchQueryDto } from "./dto/car-search.dto";
import { publicCarRefParamSchema } from "./dto/car-search.dto";

describe("CarController", () => {
  describe("searchCars", () => {
    const query: CarSearchQueryDto = { page: 1, limit: 12 };
    const searchId = "01994a1d-4263-7000-8000-0000000000aa";
    const sessionId = "01994a1d-4263-7000-8000-0000000000bb";

    let controller: CarController;
    let searchCars: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      searchCars = vi.fn();
      const module: TestingModule = await Test.createTestingModule({
        controllers: [CarController],
        providers: [
          { provide: CarCategoriesService, useValue: {} },
          { provide: CarSearchService, useValue: { searchCars } },
        ],
      }).compile();

      controller = module.get(CarController);
    });

    function requestStub(headers: Request["headers"]): Pick<Request, "headers"> {
      return { headers };
    }

    function responseStub(): Pick<Response, "setHeader"> & {
      setHeader: ReturnType<typeof vi.fn>;
    } {
      return { setHeader: vi.fn() };
    }

    it("forwards a web channel and echoes X-Search-Id", async () => {
      searchCars.mockResolvedValue({ searchId, cars: [] });
      const response = responseStub();

      const result = await controller.searchCars(
        query,
        requestStub({
          "x-search-id": searchId,
          "x-anonymous-session-id": sessionId,
          "x-request-id": "req-web-1",
          "x-client-type": "MOBILE",
        }),
        response,
      );

      expect(searchCars).toHaveBeenCalledWith(query, {
        channel: AnalyticsChannel.WEB,
        searchId,
        anonymousSessionId: sessionId,
        requestId: "req-web-1",
      });
      expect(response.setHeader).toHaveBeenCalledWith("X-Search-Id", searchId);
      expect(result).toEqual({ searchId, cars: [] });
    });

    it("forwards MOBILE_APP when X-Client-Type is exactly mobile", async () => {
      searchCars.mockResolvedValue({ searchId, cars: [] });
      const response = responseStub();

      await controller.searchCars(
        query,
        requestStub({
          "x-client-type": "mobile",
          "x-search-id": ["not-a-single-header"],
        }),
        response,
      );

      expect(searchCars).toHaveBeenCalledWith(query, {
        channel: AnalyticsChannel.MOBILE_APP,
        searchId: undefined,
        anonymousSessionId: undefined,
        requestId: undefined,
      });
      expect(response.setHeader).toHaveBeenCalledWith("X-Search-Id", searchId);
    });

    it("does not set X-Search-Id when the search result has none", async () => {
      searchCars.mockResolvedValue({ cars: [] });
      const response = responseStub();

      await controller.searchCars(query, requestStub({}), response);

      expect(searchCars).toHaveBeenCalledWith(
        query,
        expect.objectContaining({ channel: AnalyticsChannel.WEB }),
      );
      expect(response.setHeader).not.toHaveBeenCalled();
    });

    it("marks search responses as not stored", () => {
      expect(Reflect.getMetadata(HEADERS_METADATA, CarController.prototype.searchCars)).toEqual([
        { name: "Cache-Control", value: "no-store" },
      ]);
    });
  });

  describe("getPublicCarByRef", () => {
    it("accepts only 16-character lowercase hexadecimal references", () => {
      expect(publicCarRefParamSchema.safeParse("0123456789abcdef").success).toBe(true);
      expect(publicCarRefParamSchema.safeParse("0123456789ABCDEf").success).toBe(false);
      expect(publicCarRefParamSchema.safeParse("short").success).toBe(false);
    });
  });
});
