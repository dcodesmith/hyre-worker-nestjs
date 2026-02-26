import { Controller, Get, Header } from "@nestjs/common";
import { ZodParam, ZodQuery } from "../../common/decorators/zod-validation.decorator";
import { CarCategoriesService } from "./car-categories.service";
import { CarSearchService } from "./car-search.service";
import { type CarCategoriesQueryDto, carCategoriesQuerySchema } from "./dto/car-categories.dto";
import { type CarSearchQueryDto, carSearchQuerySchema } from "./dto/car-search.dto";
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
  @Header("Cache-Control", "public, max-age=60, stale-while-revalidate=300")
  async searchCars(@ZodQuery(carSearchQuerySchema) query: CarSearchQueryDto) {
    return this.carSearchService.searchCars(query);
  }

  @Get(":carId")
  @Header("Cache-Control", "public, max-age=60, stale-while-revalidate=300")
  async getPublicCarById(@ZodParam("carId", carIdParamSchema) carId: string) {
    return this.carSearchService.getPublicCarById(carId);
  }
}
