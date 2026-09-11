import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AddonsController } from "./addons.controller";
import { AddonsService } from "./addons.service";
import { AdminAddonsController } from "./admin-addons.controller";

@Module({
  imports: [AuthModule],
  controllers: [AddonsController, AdminAddonsController],
  providers: [AddonsService],
  exports: [AddonsService],
})
export class AddonsModule {}
