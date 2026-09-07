import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { EmailModule } from "../email/email.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { AuthEmailService } from "./auth-email.service";
import { OptionalSessionGuard } from "./guards/optional-session.guard";
import { RoleGuard } from "./guards/role.guard";
import { SessionGuard } from "./guards/session.guard";
import { VerifiedFleetOwnerGuard } from "./guards/verified-fleet-owner.guard";

@Module({
  imports: [DatabaseModule, EmailModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthEmailService,
    SessionGuard,
    OptionalSessionGuard,
    RoleGuard,
    VerifiedFleetOwnerGuard,
  ],
  exports: [AuthService, SessionGuard, OptionalSessionGuard, RoleGuard, VerifiedFleetOwnerGuard],
})
export class AuthModule {}
