import { Controller, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { type AuthSession, SessionGuard } from "../auth/guards/session.guard";
import type { DeleteAccountResponse } from "./account.interface";
import { AccountService } from "./account.service";

@Controller("api/account")
export class AccountController {
  constructor(private readonly accountService: AccountService) {}

  @Post("delete")
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard)
  async deleteCurrentUserAccount(
    @CurrentUser() user: AuthSession["user"],
  ): Promise<DeleteAccountResponse> {
    return this.accountService.deleteUserAccount(user.id);
  }
}
