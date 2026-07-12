import {
  Controller,
  Get,
  Patch,
  Post,
  Put,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileFieldsInterceptor, FileInterceptor } from "@nestjs/platform-express";
import { ZodBody, ZodParam } from "../../common/decorators/zod-validation.decorator";
import { FLEET_OWNER } from "../auth/auth.const";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { Roles } from "../auth/decorators/roles.decorator";
import { RoleGuard } from "../auth/guards/role.guard";
import type { AuthSession } from "../auth/guards/session.guard";
import { SessionGuard } from "../auth/guards/session.guard";
import { CAR_UPLOAD_FIELD_CONFIG } from "./car.const";
import type { CarCreateFiles, UploadedCarFile } from "./car.interface";
import { CarService } from "./car.service";
import { CarCreateFilesPipe } from "./car-create-files.pipe";
import { CarDocumentFilePipe, CarImageFilePipe } from "./car-replace-file.pipe";
import { documentIdParamSchema, imageIdParamSchema } from "./dto/car-approval.dto";
import { type CreateCarMultipartBodyDto, createCarMultipartBodySchema } from "./dto/create-car.dto";
import { carIdParamSchema, type UpdateCarBodyDto, updateCarBodySchema } from "./dto/update-car.dto";

@Controller("api/fleet-owner/cars")
@UseGuards(SessionGuard, RoleGuard)
@Roles(FLEET_OWNER)
export class FleetOwnerCarController {
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

  @Put(":carId/images/:imageId/file")
  @UseInterceptors(FileInterceptor("file"))
  async replaceCarImage(
    @ZodParam("carId", carIdParamSchema) carId: string,
    @ZodParam("imageId", imageIdParamSchema) imageId: string,
    @UploadedFile(new CarImageFilePipe()) file: UploadedCarFile,
    @CurrentUser() sessionUser: AuthSession["user"],
  ) {
    return this.carService.replaceCarImage(carId, sessionUser.id, imageId, file);
  }

  @Put(":carId/documents/:documentId/file")
  @UseInterceptors(FileInterceptor("file"))
  async replaceCarDocument(
    @ZodParam("carId", carIdParamSchema) carId: string,
    @ZodParam("documentId", documentIdParamSchema) documentId: string,
    @UploadedFile(new CarDocumentFilePipe()) file: UploadedCarFile,
    @CurrentUser() sessionUser: AuthSession["user"],
  ) {
    return this.carService.replaceCarDocument(carId, sessionUser.id, documentId, file);
  }
}
