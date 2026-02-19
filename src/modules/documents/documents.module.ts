import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { DatabaseModule } from "../database/database.module";
import { DocumentProxyService } from "./document-proxy.service";
import { DocumentsController } from "./documents.controller";

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [DocumentsController],
  providers: [DocumentProxyService],
})
export class DocumentsModule {}
