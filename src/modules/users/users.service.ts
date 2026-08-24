import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { DatabaseService, isRecordNotFoundError } from "../database/database.service";
import type { UpdateCurrentUserBodyDto } from "./dto/update-current-user.dto";
import { UsersUserNotFoundException } from "./users.error";
import type { CurrentUserProfile } from "./users.interface";

const currentUserProfileSelect = {
  name: true,
  phoneNumber: true,
  city: true,
  address: true,
  marketingConsent: true,
} satisfies Prisma.UserSelect;

@Injectable()
export class UsersService {
  constructor(private readonly databaseService: DatabaseService) {}

  async getCurrentUserProfile(userId: string): Promise<CurrentUserProfile> {
    const user = await this.databaseService.user.findUnique({
      where: { id: userId },
      select: currentUserProfileSelect,
    });

    if (!user) {
      throw new UsersUserNotFoundException();
    }

    return user;
  }

  async updateCurrentUserProfile(
    userId: string,
    dto: UpdateCurrentUserBodyDto,
  ): Promise<CurrentUserProfile> {
    try {
      return await this.databaseService.user.update({
        where: { id: userId },
        data: {
          name: dto.name,
          phoneNumber: dto.phoneNumber,
          city: dto.city,
          address: dto.address,
          marketingConsent: dto.marketingConsent,
        },
        select: currentUserProfileSelect,
      });
    } catch (error) {
      if (isRecordNotFoundError(error)) {
        throw new UsersUserNotFoundException();
      }
      throw error;
    }
  }
}
