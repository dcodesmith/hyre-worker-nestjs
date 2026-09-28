import { pipeline } from "node:stream/promises";
import { Controller, Get, Header, Post, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { ZodBody, ZodParam, ZodQuery } from "../../common/decorators/zod-validation.decorator";
import { ADMIN, STAFF } from "../auth/auth.const";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { Roles } from "../auth/decorators/roles.decorator";
import { RoleGuard } from "../auth/guards/role.guard";
import type { AuthSession } from "../auth/guards/session.guard";
import { SessionGuard } from "../auth/guards/session.guard";
import {
  type ApproveInterventionDto,
  approveInterventionSchema,
  interventionIdSchema,
  type ListInterventionsDto,
  listInterventionsSchema,
  type RejectInterventionDto,
  rejectInterventionSchema,
} from "./intervention.dto";
import { InterventionService } from "./intervention.service";

@Controller("api/admin/verification-interventions")
@UseGuards(SessionGuard, RoleGuard)
@Roles(ADMIN, STAFF)
export class InterventionController {
  constructor(private readonly interventionService: InterventionService) {}

  @Get()
  @Header("Cache-Control", "private, no-store")
  list(@ZodQuery(listInterventionsSchema) query: ListInterventionsDto) {
    return this.interventionService.list(query);
  }

  @Get(":interventionId/license-number")
  @Header("Cache-Control", "private, no-store")
  async licenseNumber(@ZodParam("interventionId", interventionIdSchema) interventionId: string) {
    return { licenseNumber: await this.interventionService.getLicenseNumber(interventionId) };
  }

  @Get(":interventionId/evidence/selfie")
  async selfie(
    @ZodParam("interventionId", interventionIdSchema) interventionId: string,
    @Res() response: Response,
  ): Promise<void> {
    const stored = await this.interventionService.getSelfie(interventionId);
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Content-Type", stored.contentType ?? "image/webp");
    if (stored.contentLength !== undefined) {
      response.setHeader("Content-Length", stored.contentLength.toString());
    }
    try {
      await pipeline(stored.stream, response);
    } catch {
      if (!response.headersSent && !response.destroyed) {
        response.status(502).end();
        return;
      }
      response.destroy();
    }
  }

  @Get(":interventionId/evidence/nin-portrait")
  async ninPortrait(
    @ZodParam("interventionId", interventionIdSchema) interventionId: string,
    @Res() response: Response,
  ): Promise<void> {
    const portrait = await this.interventionService.getNinPortrait(interventionId);
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Content-Type", "image/jpeg");
    response.end(portrait);
  }

  @Post(":interventionId/approve")
  async approve(
    @ZodParam("interventionId", interventionIdSchema) interventionId: string,
    @ZodBody(approveInterventionSchema) body: ApproveInterventionDto,
    @CurrentUser() user: AuthSession["user"],
  ) {
    await this.interventionService.approve(interventionId, user.id, body);
    return { success: true };
  }

  @Post(":interventionId/reject")
  @Roles(ADMIN)
  async reject(
    @ZodParam("interventionId", interventionIdSchema) interventionId: string,
    @ZodBody(rejectInterventionSchema) body: RejectInterventionDto,
    @CurrentUser() user: AuthSession["user"],
  ) {
    await this.interventionService.reject(interventionId, user.id, body.notes);
    return { success: true };
  }

  @Post(":interventionId/approve-document")
  async approveOwnerLicenseDocument(
    @ZodParam("interventionId", interventionIdSchema) interventionId: string,
    @CurrentUser() user: AuthSession["user"],
  ) {
    await this.interventionService.approveOwnerLicenseDocument(interventionId, user.id);
    return { success: true };
  }
}
