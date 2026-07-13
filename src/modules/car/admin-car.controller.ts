import { Controller, Get, Patch, Post, UseGuards } from "@nestjs/common";
import { ZodBody, ZodParam, ZodQuery } from "../../common/decorators/zod-validation.decorator";
import { ADMIN, STAFF } from "../auth/auth.const";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { Roles } from "../auth/decorators/roles.decorator";
import { RoleGuard } from "../auth/guards/role.guard";
import type { AuthSession } from "../auth/guards/session.guard";
import { SessionGuard } from "../auth/guards/session.guard";
import { CarApprovalService } from "./car-approval.service";
import {
  cuidParamSchema,
  type ListCarsForReviewQueryDto,
  listCarsForReviewQuerySchema,
  type RejectBodyDto,
  rejectBodySchema,
  type SetCoverBodyDto,
  setCoverBodySchema,
} from "./dto/car-approval.dto";
import { carIdParamSchema } from "./dto/update-car.dto";

@Controller("api/admin/cars")
@UseGuards(SessionGuard, RoleGuard)
export class AdminCarController {
  constructor(private readonly carApprovalService: CarApprovalService) {}

  @Get()
  @Roles(ADMIN, STAFF)
  async listCarsForReview(
    @ZodQuery(listCarsForReviewQuerySchema) query: ListCarsForReviewQueryDto,
  ) {
    return this.carApprovalService.listCarsForReview(query);
  }

  @Get(":carId")
  @Roles(ADMIN, STAFF)
  async getCarForReview(@ZodParam("carId", carIdParamSchema) carId: string) {
    return this.carApprovalService.getCarForReview(carId);
  }

  @Post(":carId/approve")
  @Roles(ADMIN)
  async approveCar(@ZodParam("carId", carIdParamSchema) carId: string) {
    return this.carApprovalService.approveCar(carId);
  }

  @Patch(":carId/cover")
  @Roles(ADMIN)
  async setCoverImage(
    @ZodParam("carId", carIdParamSchema) carId: string,
    @ZodBody(setCoverBodySchema) body: SetCoverBodyDto,
  ) {
    return this.carApprovalService.setCoverImage(carId, body.imageId);
  }

  @Post(":carId/images/:imageId/approve")
  @Roles(ADMIN, STAFF)
  async approveImage(
    @ZodParam("carId", carIdParamSchema) carId: string,
    @ZodParam("imageId", cuidParamSchema) imageId: string,
    @CurrentUser() sessionUser: AuthSession["user"],
  ) {
    return this.carApprovalService.approveImage(carId, imageId, sessionUser.id);
  }

  @Post(":carId/images/:imageId/reject")
  @Roles(ADMIN, STAFF)
  async rejectImage(
    @ZodParam("carId", carIdParamSchema) carId: string,
    @ZodParam("imageId", cuidParamSchema) imageId: string,
    @ZodBody(rejectBodySchema) body: RejectBodyDto,
    @CurrentUser() sessionUser: AuthSession["user"],
  ) {
    return this.carApprovalService.rejectImage(carId, imageId, sessionUser.id, body.notes);
  }
}
