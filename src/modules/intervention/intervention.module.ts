import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { VERIFICATION_INTERVENTION_QUEUE } from "../../config/constants";
import { AuthModule } from "../auth/auth.module";
import { DatabaseModule } from "../database/database.module";
import { DriversLicenseModule } from "../drivers-license/drivers-license.module";
import { EmailModule } from "../email/email.module";
import { SmileIdModule } from "../smile-id/smile-id.module";
import { StorageModule } from "../storage/storage.module";
import { ChauffeurActivationService } from "./chauffeur-activation.service";
import { InterventionController } from "./intervention.controller";
import { InterventionProcessor } from "./intervention.processor";
import { InterventionService } from "./intervention.service";

@Module({
  imports: [
    AuthModule,
    DatabaseModule,
    DriversLicenseModule,
    EmailModule,
    SmileIdModule,
    StorageModule,
    BullModule.registerQueue({ name: VERIFICATION_INTERVENTION_QUEUE }),
    BullBoardModule.forFeature({
      name: VERIFICATION_INTERVENTION_QUEUE,
      adapter: BullMQAdapter,
    }),
  ],
  controllers: [InterventionController],
  providers: [ChauffeurActivationService, InterventionService, InterventionProcessor],
  exports: [ChauffeurActivationService, InterventionService],
})
export class InterventionModule {}
