import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { DatabaseModule } from "../database/database.module";
import { EmailModule } from "../email/email.module";
import { StorageModule } from "../storage/storage.module";
import { ChauffeurActivationService } from "./chauffeur-activation.service";
import { InterventionController } from "./intervention.controller";
import { InterventionService } from "./intervention.service";

@Module({
  imports: [AuthModule, DatabaseModule, EmailModule, StorageModule],
  controllers: [InterventionController],
  providers: [ChauffeurActivationService, InterventionService],
  exports: [ChauffeurActivationService, InterventionService],
})
export class InterventionModule {}
