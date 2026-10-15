import { HEADERS_METADATA } from "@nestjs/common/constants";
import { describe, expect, it, vi } from "vitest";
import { AnalyticsSource } from "../analytics/analytics-event.schema";
import { CarController } from "./car.controller";
import type { CarSearchQueryDto } from "./dto/car-search.dto";
import { publicCarRefParamSchema } from "./dto/car-search.dto";

describe("CarController", () => {
  describe("searchCars", () => {
    const query = { page: 1, limit: 12 } as CarSearchQueryDto;
    const searchId = "01994a1d-4263-7000-8000-0000000000aa";

    it("passes header context and sets X-Search-Id when the search returns one", async () => {
      const searchCars = vi.fn().mockResolvedValue({ searchId, cars: [] });
      const controller = new CarController({} as never, { searchCars } as never);
      const response = { setHeader: vi.fn() };

      const result = await controller.searchCars(
        query,
        {
          headers: {
            "x-search-id": searchId,
            "x-anonymous-session-id": "01994a1d-4263-7000-8000-0000000000bb",
            "x-request-id": "req-web-1",
          },
        } as never,
        response as never,
      );

      expect(searchCars).toHaveBeenCalledWith(query, {
        source: AnalyticsSource.WEB_CAR_SEARCH,
        searchId,
        anonymousSessionId: "01994a1d-4263-7000-8000-0000000000bb",
        requestId: "req-web-1",
      });
      expect(response.setHeader).toHaveBeenCalledWith("X-Search-Id", searchId);
      expect(result).toEqual({ searchId, cars: [] });
    });

    it("does not set X-Search-Id when the search result has none", async () => {
      const searchCars = vi.fn().mockResolvedValue({ cars: [] });
      const controller = new CarController({} as never, { searchCars } as never);
      const response = { setHeader: vi.fn() };

      await controller.searchCars(query, { headers: {} } as never, response as never);

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
