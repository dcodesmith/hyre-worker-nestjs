import { Controller, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { ZodBody } from "../../common/decorators/zod-validation.decorator";
import { ADMIN } from "../auth/auth.const";
import { Roles } from "../auth/decorators/roles.decorator";
import { RoleGuard } from "../auth/guards/role.guard";
import { SessionGuard } from "../auth/guards/session.guard";
import { type CreateStaffBodyDto, createStaffBodySchema } from "./dto/create-staff.dto";
import { UsersService } from "./users.service";

@Controller("api/admin/staff")
@UseGuards(SessionGuard, RoleGuard)
@Roles(ADMIN)
export class AdminStaffController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  createStaff(@ZodBody(createStaffBodySchema) body: CreateStaffBodyDto) {
    return this.usersService.createStaff(body);
  }
}
