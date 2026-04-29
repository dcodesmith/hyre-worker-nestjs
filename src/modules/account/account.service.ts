import { Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { DatabaseService } from "../database/database.service";
import {
  AccountDeleteFailedException,
  AccountException,
  AccountUserNotFoundException,
} from "./account.error";
import type { DeleteAccountResponse } from "./account.interface";

@Injectable()
export class AccountService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AccountService.name);
  }

  async deleteUserAccount(userId: string): Promise<DeleteAccountResponse> {
    try {
      const user = await this.databaseService.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true },
      });

      if (!user) {
        throw new AccountUserNotFoundException();
      }

      const [anonymizedBookings] = await this.databaseService.$transaction([
        this.databaseService.booking.updateMany({
          where: { userId },
          data: {
            userId: null,
            guestUser: null,
          },
        }),
        this.databaseService.user.delete({
          where: { id: userId },
        }),
      ]);

      this.logger.info(
        {
          userId,
          anonymizedBookings: anonymizedBookings.count,
        },
        "Account deleted",
      );

      return { success: true };
    } catch (error) {
      if (error instanceof AccountException) {
        throw error;
      }
      throw new AccountDeleteFailedException();
    }
  }
}
