import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { EmailModule } from "../email/email.module";
import { MonoModule } from "../mono/mono.module";
import { PremblyModule } from "../prembly/prembly.module";
import { SmileIdModule } from "../smile-id/smile-id.module";
import { StorageModule } from "../storage/storage.module";
import { VerificationModule } from "../verification/verification.module";
import {
  ChauffeurOnboardingController,
  FleetOwnerChauffeurController,
} from "./chauffeur.controller";
import { ChauffeurService } from "./chauffeur.service";
import { ChauffeurImageService } from "./chauffeur-image.service";
import { ChauffeurSessionGuard } from "./chauffeur-session.guard";
import { SmileIdWebhookController } from "./smile-id-webhook.controller";

@Module({
  imports: [
    AuthModule,
    EmailModule,
    MonoModule,
    PremblyModule,
    SmileIdModule,
    StorageModule,
    VerificationModule,
  ],
  controllers: [
    FleetOwnerChauffeurController,
    ChauffeurOnboardingController,
    SmileIdWebhookController,
  ],
  providers: [ChauffeurService, ChauffeurImageService, ChauffeurSessionGuard],
})
export class ChauffeurModule {}
