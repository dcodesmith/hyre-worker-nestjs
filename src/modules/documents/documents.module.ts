import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { CarModule } from "../car/car.module";
import { DatabaseModule } from "../database/database.module";
import { AdminDocumentController } from "./admin-document.controller";
import { DocumentApprovalService } from "./document-approval.service";
import { DocumentProxyService } from "./document-proxy.service";
import { DocumentsController } from "./documents.controller";

@Module({
  imports: [DatabaseModule, AuthModule, CarModule],
  controllers: [DocumentsController, AdminDocumentController],
  providers: [DocumentProxyService, DocumentApprovalService],
})
export class DocumentsModule {}
