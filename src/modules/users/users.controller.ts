import { Controller, Get, HttpCode, HttpStatus, Patch, UseGuards } from "@nestjs/common";
import { ZodBody } from "../../common/decorators/zod-validation.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { type AuthSession, SessionGuard } from "../auth/guards/session.guard";
import {
  type UpdateCurrentUserBodyDto,
  updateCurrentUserBodySchema,
} from "./dto/update-current-user.dto";
import type { CurrentUserProfile } from "./users.interface";
import { UsersService } from "./users.service";

@Controller("api/users/me")
@UseGuards(SessionGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  async getCurrentUserProfile(
    @CurrentUser() user: AuthSession["user"],
  ): Promise<CurrentUserProfile> {
    return this.usersService.getCurrentUserProfile(user.id);
  }

  @Patch()
  @HttpCode(HttpStatus.OK)
  async updateCurrentUserProfile(
    @CurrentUser() user: AuthSession["user"],
    @ZodBody(updateCurrentUserBodySchema) body: UpdateCurrentUserBodyDto,
  ): Promise<CurrentUserProfile> {
    return this.usersService.updateCurrentUserProfile(user.id, body);
  }
}
