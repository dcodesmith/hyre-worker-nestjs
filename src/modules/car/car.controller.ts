import {
  Controller,
  Get,
  Patch,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileFieldsInterceptor } from "@nestjs/platform-express";
import { ZodBody, ZodParam } from "../../common/decorators/zod-validation.decorator";
import { FLEET_OWNER } from "../auth/auth.types";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { Roles } from "../auth/decorators/roles.decorator";
import { RoleGuard } from "../auth/guards/role.guard";
import type { AuthSession } from "../auth/guards/session.guard";
import { SessionGuard } from "../auth/guards/session.guard";
import { CAR_UPLOAD_FIELD_CONFIG } from "./car.const";
import type { CarCreateFiles } from "./car.interface";
import { CarService } from "./car.service";
import { CarCreateFilesPipe } from "./car-create-files.pipe";
import { type CreateCarMultipartBodyDto, createCarMultipartBodySchema } from "./dto/create-car.dto";
import { carIdParamSchema, type UpdateCarBodyDto, updateCarBodySchema } from "./dto/update-car.dto";

@Controller("api/cars")
@UseGuards(SessionGuard, RoleGuard)
@Roles(FLEET_OWNER)
export class CarController {
  constructor(private readonly carService: CarService) {}

  @Get()
  async listOwnerCars(@CurrentUser() sessionUser: AuthSession["user"]) {
    return this.carService.listOwnerCars(sessionUser.id);
  }

  @Get(":carId")
  async getOwnerCarById(
    @ZodParam("carId", carIdParamSchema) carId: string,
    @CurrentUser() sessionUser: AuthSession["user"],
  ) {
    return this.carService.getOwnerCarById(carId, sessionUser.id);
  }

  @Post()
  @UseInterceptors(FileFieldsInterceptor([...CAR_UPLOAD_FIELD_CONFIG]))
  async createCar(
    @ZodBody(createCarMultipartBodySchema) body: CreateCarMultipartBodyDto,
    @UploadedFiles(new CarCreateFilesPipe()) files: CarCreateFiles,
    @CurrentUser() sessionUser: AuthSession["user"],
  ) {
    return this.carService.createCar(sessionUser.id, body, files);
  }

  @Patch(":carId")
  async updateCar(
    @ZodParam("carId", carIdParamSchema) carId: string,
    @ZodBody(updateCarBodySchema) body: UpdateCarBodyDto,
    @CurrentUser() sessionUser: AuthSession["user"],
  ) {
    return this.carService.updateCar(carId, sessionUser.id, body);
  }
}
