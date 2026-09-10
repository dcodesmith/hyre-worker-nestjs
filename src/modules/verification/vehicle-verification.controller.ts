import { Controller, Get, Headers, Post, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { ZodBody, ZodParam } from "../../common/decorators/zod-validation.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { FLEET_OWNER } from "../auth/auth.const";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { Roles } from "../auth/decorators/roles.decorator";
import { RoleGuard } from "../auth/guards/role.guard";
import type { AuthSession } from "../auth/guards/session.guard";
import { SessionGuard } from "../auth/guards/session.guard";
import { VerifiedFleetOwnerGuard } from "../auth/guards/verified-fleet-owner.guard";
import { idempotencyKeySchema } from "../booking/dto/idempotency-key.dto";
import { carIdParamSchema } from "../car/dto/update-car.dto";
import {
  type CreateInsuranceVerificationDto,
  type CreateVehicleVerificationDto,
  createInsuranceVerificationSchema,
  createVehicleVerificationSchema,
  vehicleVerificationIdSchema,
} from "./vehicle-verification.dto";
import { VehicleVerificationService } from "./vehicle-verification.service";
import {
  VerificationRequestInProgressException,
  VerificationValidationException,
} from "./verification.error";
import { VerificationThrottlerGuard } from "./verification-throttler.guard";

const idempotencyKeyPipe = new ZodValidationPipe(idempotencyKeySchema, {
  exceptionFactory: (errors) =>
    new VerificationValidationException(
      errors.map((error) => ({ ...error, field: "Idempotency-Key" })),
    ),
});

@Controller("api/fleet-owner/vehicle-verifications")
@UseGuards(SessionGuard, RoleGuard, VerifiedFleetOwnerGuard)
@Roles(FLEET_OWNER)
export class VehicleVerificationController {
  constructor(private readonly verificationService: VehicleVerificationService) {}

  @Post()
  @UseGuards(VerificationThrottlerGuard)
  async create(
    @ZodBody(createVehicleVerificationSchema) body: CreateVehicleVerificationDto,
    @Headers("Idempotency-Key") rawIdempotencyKey: string,
    @CurrentUser() sessionUser: AuthSession["user"],
    @Res({ passthrough: true }) response: Response,
  ) {
    const idempotencyKey = idempotencyKeyPipe.transform(rawIdempotencyKey);
    try {
      return await this.verificationService.createVehicleVerification(
        sessionUser.id,
        idempotencyKey,
        body,
      );
    } catch (error) {
      if (error instanceof VerificationRequestInProgressException) {
        response.setHeader("Retry-After", String(error.retryAfterSeconds));
      }
      throw error;
    }
  }

  @Get(":verificationId")
  async get(
    @ZodParam("verificationId", vehicleVerificationIdSchema) verificationId: string,
    @CurrentUser() sessionUser: AuthSession["user"],
  ) {
    return this.verificationService.getVehicleVerification(sessionUser.id, verificationId);
  }

  @Post(":verificationId/car")
  async createDraftCar(
    @ZodParam("verificationId", vehicleVerificationIdSchema) verificationId: string,
    @CurrentUser() sessionUser: AuthSession["user"],
  ) {
    return this.verificationService.createDraftCar(sessionUser.id, verificationId);
  }
}

@Controller("api/fleet-owner/cars/:carId/insurance-verifications")
@UseGuards(SessionGuard, RoleGuard, VerifiedFleetOwnerGuard)
@Roles(FLEET_OWNER)
export class InsuranceVerificationController {
  constructor(private readonly verificationService: VehicleVerificationService) {}

  @Post()
  @UseGuards(VerificationThrottlerGuard)
  async create(
    @ZodParam("carId", carIdParamSchema) carId: string,
    @ZodBody(createInsuranceVerificationSchema) body: CreateInsuranceVerificationDto,
    @Headers("Idempotency-Key") rawIdempotencyKey: string,
    @CurrentUser() sessionUser: AuthSession["user"],
    @Res({ passthrough: true }) response: Response,
  ) {
    const idempotencyKey = idempotencyKeyPipe.transform(rawIdempotencyKey);
    try {
      return await this.verificationService.createInsuranceVerification({
        ownerId: sessionUser.id,
        carId,
        idempotencyKey,
        input: body,
      });
    } catch (error) {
      if (error instanceof VerificationRequestInProgressException) {
        response.setHeader("Retry-After", String(error.retryAfterSeconds));
      }
      throw error;
    }
  }
}
