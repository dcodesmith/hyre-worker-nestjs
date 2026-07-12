import { Controller, Post, UseGuards } from "@nestjs/common";
import { ZodBody, ZodParam } from "../../common/decorators/zod-validation.decorator";
import { ADMIN, STAFF } from "../auth/auth.const";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { Roles } from "../auth/decorators/roles.decorator";
import { RoleGuard } from "../auth/guards/role.guard";
import type { AuthSession } from "../auth/guards/session.guard";
import { SessionGuard } from "../auth/guards/session.guard";
import { DocumentApprovalService } from "./document-approval.service";
import { type RejectBodyDto, rejectBodySchema } from "./dto/document-approval.dto";
import { documentIdParamSchema } from "./dto/proxy-pdf.dto";

@Controller("api/admin/documents")
@UseGuards(SessionGuard, RoleGuard)
@Roles(ADMIN, STAFF)
export class AdminDocumentController {
  constructor(private readonly documentApprovalService: DocumentApprovalService) {}

  @Post(":documentId/approve")
  async approveDocument(
    @ZodParam("documentId", documentIdParamSchema) documentId: string,
    @CurrentUser() sessionUser: AuthSession["user"],
  ) {
    return this.documentApprovalService.approveDocument(documentId, sessionUser.id);
  }

  @Post(":documentId/reject")
  async rejectDocument(
    @ZodParam("documentId", documentIdParamSchema) documentId: string,
    @ZodBody(rejectBodySchema) body: RejectBodyDto,
    @CurrentUser() sessionUser: AuthSession["user"],
  ) {
    return this.documentApprovalService.rejectDocument(documentId, sessionUser.id, body.notes);
  }
}
