import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { DatabaseModule } from "../database/database.module";
import { AdminStaffController } from "./admin-staff.controller";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [UsersController, AdminStaffController],
  providers: [UsersService],
})
export class UsersModule {}
