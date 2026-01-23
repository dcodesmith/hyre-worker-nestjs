import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { NotificationModule } from "../notification/notification.module";
import { AuthController } from "./auth.controller";
import { AuthEmailService } from "./auth-email.service";
import { AuthService } from "./auth.service";

@Module({
  imports: [DatabaseModule, NotificationModule],
  controllers: [AuthController],
  providers: [AuthService, AuthEmailService],
  exports: [AuthService],
})
export class AuthModule {}
