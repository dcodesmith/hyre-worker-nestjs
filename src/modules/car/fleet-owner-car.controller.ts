import {
  Controller,
  Get,
  GoneException,
  Patch,
  Post,
  Put,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileFieldsInterceptor, FileInterceptor, FilesInterceptor } from "@nestjs/platform-express";
import { ZodBody, ZodParam } from "../../common/decorators/zod-validation.decorator";
import { FLEET_OWNER } from "../auth/auth.const";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { Roles } from "../auth/decorators/roles.decorator";
import { RoleGuard } from "../auth/guards/role.guard";
import type { AuthSession } from "../auth/guards/session.guard";
import { SessionGuard } from "../auth/guards/session.guard";
import { CAR_DOCUMENT_UPLOAD_FIELD_CONFIG, MAX_IMAGE_COUNT } from "./car.const";
import type { CarDocumentFiles, UploadedCarFile } from "./car.interface";
import { CarService } from "./car.service";
import { CarDocumentsPipe } from "./car-documents.pipe";
import { CarImagesPipe } from "./car-images.pipe";
import { CarReplaceFilePipe } from "./car-replace-file.pipe";
import { cuidParamSchema } from "./dto/car-approval.dto";
import { carIdParamSchema, type UpdateCarBodyDto, updateCarBodySchema } from "./dto/update-car.dto";
import { type UpdateCarPricingDto, updateCarPricingSchema } from "./dto/update-car-pricing.dto";

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
  createCar() {
    throw new GoneException(
      "Start car onboarding with POST /api/fleet-owner/vehicle-verifications",
    );
  }

  @Patch(":carId")
  async updateCar(
    @ZodParam("carId", carIdParamSchema) carId: string,
    @ZodBody(updateCarBodySchema) body: UpdateCarBodyDto,
    @CurrentUser() sessionUser: AuthSession["user"],
  ) {
    return this.carService.updateCar(carId, sessionUser.id, body);
  }

  @Post(":carId/documents")
  @UseInterceptors(FileFieldsInterceptor([...CAR_DOCUMENT_UPLOAD_FIELD_CONFIG]))
  async uploadDraftCarDocuments(
    @ZodParam("carId", carIdParamSchema) carId: string,
    @UploadedFiles(new CarDocumentsPipe()) files: CarDocumentFiles,
    @CurrentUser() sessionUser: AuthSession["user"],
  ) {
    return this.carService.uploadDraftCarDocuments(carId, sessionUser.id, files);
  }

  @Post(":carId/images")
  @UseInterceptors(FilesInterceptor("images", MAX_IMAGE_COUNT))
  async uploadDraftCarImages(
    @ZodParam("carId", carIdParamSchema) carId: string,
    @UploadedFiles(new CarImagesPipe()) images: UploadedCarFile[],
    @CurrentUser() sessionUser: AuthSession["user"],
  ) {
    return this.carService.uploadDraftCarImages(carId, sessionUser.id, images);
  }

  @Patch(":carId/pricing")
  async updateDraftCarPricing(
    @ZodParam("carId", carIdParamSchema) carId: string,
    @ZodBody(updateCarPricingSchema) body: UpdateCarPricingDto,
    @CurrentUser() sessionUser: AuthSession["user"],
  ) {
    return this.carService.updateDraftCarPricing(carId, sessionUser.id, body);
  }

  @Post(":carId/submissions")
  async submitCar(
    @ZodParam("carId", carIdParamSchema) carId: string,
    @CurrentUser() sessionUser: AuthSession["user"],
  ) {
    return this.carService.submitCar(carId, sessionUser.id);
  }

  @Put(":carId/images/:imageId/file")
  @UseInterceptors(FileInterceptor("file"))
  async replaceCarImage(
    @ZodParam("carId", carIdParamSchema) carId: string,
    @ZodParam("imageId", cuidParamSchema) imageId: string,
    @UploadedFile(new CarReplaceFilePipe("image")) file: UploadedCarFile,
    @CurrentUser() sessionUser: AuthSession["user"],
  ) {
    return this.carService.replaceCarImage(carId, sessionUser.id, imageId, file);
  }

  @Put(":carId/documents/:documentId/file")
  @UseInterceptors(FileInterceptor("file"))
  async replaceCarDocument(
    @ZodParam("carId", carIdParamSchema) carId: string,
    @ZodParam("documentId", cuidParamSchema) documentId: string,
    @UploadedFile(new CarReplaceFilePipe("document")) file: UploadedCarFile,
    @CurrentUser() sessionUser: AuthSession["user"],
  ) {
    return this.carService.replaceCarDocument(carId, sessionUser.id, documentId, file);
  }
}
