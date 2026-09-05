import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { STAFF, USER } from "../auth/auth.const";
import { DatabaseService, isRecordNotFoundError } from "../database/database.service";
import type { CreateStaffBodyDto } from "./dto/create-staff.dto";
import type { UpdateCurrentUserBodyDto } from "./dto/update-current-user.dto";
import { UsersStaffRoleConflictException, UsersUserNotFoundException } from "./users.error";
import type { CurrentUserProfile } from "./users.interface";

const currentUserProfileSelect = {
  name: true,
  phoneNumber: true,
  city: true,
  address: true,
  marketingConsent: true,
} satisfies Prisma.UserSelect;

const staffMemberSelect = {
  id: true,
  name: true,
  email: true,
  phoneNumber: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

@Injectable()
export class UsersService {
  constructor(private readonly databaseService: DatabaseService) {}

  async createStaff(dto: CreateStaffBodyDto) {
    const existingUser = await this.databaseService.user.findUnique({
      where: { email: dto.email },
      select: { roles: { select: { name: true } } },
    });

    const hasIncompatibleRole = existingUser?.roles.some(
      ({ name }) => name !== USER && name !== STAFF,
    );
    if (hasIncompatibleRole) {
      throw new UsersStaffRoleConflictException();
    }

    return this.databaseService.user.upsert({
      where: { email: dto.email },
      update: {
        roles: { connect: { name: STAFF } },
      },
      create: {
        name: dto.name,
        email: dto.email,
        phoneNumber: dto.phoneNumber,
        roles: { connect: { name: STAFF } },
      },
      select: staffMemberSelect,
    });
  }

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
