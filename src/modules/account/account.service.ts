import { Injectable, Logger } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import {
  AccountDeleteFailedException,
  AccountException,
  AccountUserNotFoundException,
} from "./account.error";
import type { DeleteAccountResponse } from "./account.interface";

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(private readonly databaseService: DatabaseService) {}

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

      this.logger.log("Account deleted", {
        userId,
        anonymizedBookings: anonymizedBookings.count,
      });

      return { success: true };
    } catch (error) {
      if (error instanceof AccountException) {
        throw error;
      }
      throw new AccountDeleteFailedException();
    }
  }
}
