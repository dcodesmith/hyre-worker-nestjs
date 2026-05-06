import { Controller, Delete, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { ZodBody, ZodParam } from "../../common/decorators/zod-validation.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { type AuthSession, SessionGuard } from "../auth/guards/session.guard";
import {
  pushTokenParamSchema,
  type RegisterPushTokenBodyDto,
  registerPushTokenBodySchema,
} from "./dto/push-token.dto";
import { PushTokenService } from "./push-token.service";

@Controller("api/users/me/push-tokens")
@UseGuards(SessionGuard)
export class PushTokenController {
  constructor(private readonly pushTokenService: PushTokenService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async registerPushToken(
    @CurrentUser() user: AuthSession["user"],
    @ZodBody(registerPushTokenBodySchema) body: RegisterPushTokenBodyDto,
  ): Promise<{ success: true }> {
    await this.pushTokenService.registerToken(user.id, body.token, body.platform);
    return { success: true };
  }

  @Delete(":token")
  @HttpCode(HttpStatus.OK)
  async deletePushToken(
    @CurrentUser() user: AuthSession["user"],
    @ZodParam("token", pushTokenParamSchema) token: string,
  ): Promise<{ success: true }> {
    await this.pushTokenService.revokeToken(user.id, token);
    return { success: true };
  }
}
