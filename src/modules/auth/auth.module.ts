import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { NotificationModule } from "../notification/notification.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { AuthEmailService } from "./auth-email.service";
import { RoleGuard } from "./guards/role.guard";
import { SessionGuard } from "./guards/session.guard";

@Module({
  imports: [DatabaseModule, NotificationModule],
  controllers: [AuthController],
  providers: [AuthService, AuthEmailService, SessionGuard, RoleGuard],
  exports: [AuthService, SessionGuard, RoleGuard],
})
export class AuthModule {}
