import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { DriversLicenseModule } from "../drivers-license/drivers-license.module";
import { EmailModule } from "../email/email.module";
import { InterventionModule } from "../intervention/intervention.module";
import { NinModule } from "../nin/nin.module";
import { StorageModule } from "../storage/storage.module";
import { VerificationModule } from "../verification/verification.module";
import {
  ChauffeurOnboardingController,
  FleetOwnerChauffeurController,
} from "./chauffeur.controller";
import { ChauffeurService } from "./chauffeur.service";
import { ChauffeurSessionGuard } from "./chauffeur-session.guard";

@Module({
  imports: [
    AuthModule,
    DriversLicenseModule,
    EmailModule,
    InterventionModule,
    NinModule,
    StorageModule,
    VerificationModule,
  ],
  controllers: [FleetOwnerChauffeurController, ChauffeurOnboardingController],
  providers: [ChauffeurService, ChauffeurSessionGuard],
})
export class ChauffeurModule {}
