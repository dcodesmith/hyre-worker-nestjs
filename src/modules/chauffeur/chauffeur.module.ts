import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { EmailModule } from "../email/email.module";
import { PremblyModule } from "../prembly/prembly.module";
import { StorageModule } from "../storage/storage.module";
import { VerificationModule } from "../verification/verification.module";
import {
  ChauffeurOnboardingController,
  FleetOwnerChauffeurController,
} from "./chauffeur.controller";
import { ChauffeurService } from "./chauffeur.service";
import { ChauffeurImageService } from "./chauffeur-image.service";
import { ChauffeurSessionGuard } from "./chauffeur-session.guard";

@Module({
  imports: [AuthModule, EmailModule, PremblyModule, StorageModule, VerificationModule],
  controllers: [FleetOwnerChauffeurController, ChauffeurOnboardingController],
  providers: [ChauffeurService, ChauffeurImageService, ChauffeurSessionGuard],
})
export class ChauffeurModule {}
