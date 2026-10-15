import { Controller, Get, Header, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { ZodParam, ZodQuery } from "../../common/decorators/zod-validation.decorator";
import { AnalyticsSource } from "../analytics/analytics-event.schema";
import { CarCategoriesService } from "./car-categories.service";
import { CarSearchService } from "./car-search.service";
import { type CarCategoriesQueryDto, carCategoriesQuerySchema } from "./dto/car-categories.dto";
import {
  type CarSearchQueryDto,
  carSearchQuerySchema,
  type PublicCarDetailQueryDto,
  publicCarDetailQuerySchema,
  publicCarRefParamSchema,
} from "./dto/car-search.dto";
import { carIdParamSchema } from "./dto/update-car.dto";

@Controller("api/cars")
export class CarController {
  constructor(
    private readonly carCategoriesService: CarCategoriesService,
    private readonly carSearchService: CarSearchService,
  ) {}

  @Get("categories")
  @Header("Cache-Control", "public, max-age=300, stale-while-revalidate=1800")
  async getCarCategories(@ZodQuery(carCategoriesQuerySchema) query: CarCategoriesQueryDto) {
    return this.carCategoriesService.getCategorizedCars(query);
  }

  @Get("search")
  @Header("Cache-Control", "no-store")
  async searchCars(
    @ZodQuery(carSearchQuerySchema) query: CarSearchQueryDto,
    @Req() request?: Request,
    @Res({ passthrough: true }) response?: Response,
  ) {
    const header = (name: string) => {
      const value = request?.headers[name];
      return typeof value === "string" ? value : undefined;
    };
    const result = await this.carSearchService.searchCars(query, {
      source: AnalyticsSource.WEB_CAR_SEARCH,
      searchId: header("x-search-id"),
      anonymousSessionId: header("x-anonymous-session-id"),
      requestId: header("x-request-id"),
    });
    if (result.searchId) {
      response?.setHeader("X-Search-Id", result.searchId);
    }
    return result;
  }

  @Get("by-ref/:publicRef")
  @Header("Cache-Control", "public, max-age=60, stale-while-revalidate=300")
  async getPublicCarByRef(
    @ZodParam("publicRef", publicCarRefParamSchema) publicRef: string,
    @ZodQuery(publicCarDetailQuerySchema) query: PublicCarDetailQueryDto = {},
  ) {
    return this.carSearchService.getPublicCarByRef(publicRef, query.from);
  }

  @Get(":carId")
  @Header("Cache-Control", "public, max-age=60, stale-while-revalidate=300")
  async getPublicCarById(
    @ZodParam("carId", carIdParamSchema) carId: string,
    @ZodQuery(publicCarDetailQuerySchema) query: PublicCarDetailQueryDto = {},
  ) {
    return this.carSearchService.getPublicCarById(carId, query.from);
  }
}
