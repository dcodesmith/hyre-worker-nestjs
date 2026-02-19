import { Controller, Get, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { ZodParam } from "../../common/decorators/zod-validation.decorator";
import { ADMIN } from "../auth/auth.types";
import { Roles } from "../auth/decorators/roles.decorator";
import { RoleGuard } from "../auth/guards/role.guard";
import { SessionGuard } from "../auth/guards/session.guard";
import { DocumentProxyService } from "./document-proxy.service";
import { documentIdParamSchema } from "./dto/proxy-pdf.dto";

@Controller("api")
export class DocumentsController {
  constructor(private readonly documentProxyService: DocumentProxyService) {}

  @Get("proxy-pdf/:documentId")
  @UseGuards(SessionGuard, RoleGuard)
  @Roles(ADMIN)
  async proxyPdf(
    @ZodParam("documentId", documentIdParamSchema) documentId: string,
    @Res() response: Response,
  ): Promise<void> {
    const proxiedFile = await this.documentProxyService.getPdfByDocumentId(documentId);

    response.setHeader("Content-Type", proxiedFile.contentType);
    response.setHeader("Content-Disposition", `inline; filename="${proxiedFile.fileName}"`);
    response.setHeader("Cache-Control", "max-age=300");

    if (proxiedFile.contentLength !== undefined) {
      response.setHeader("Content-Length", proxiedFile.contentLength.toString());
    }

    proxiedFile.stream.on("error", () => {
      if (!response.headersSent) {
        response.status(502).end();
        return;
      }
      response.end();
    });

    proxiedFile.stream.pipe(response);
  }
}
