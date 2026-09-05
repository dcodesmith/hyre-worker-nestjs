import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { hasStaffRoleConflict, STAFF } from "../auth/auth.const";
import {
  DatabaseService,
  isRecordNotFoundError,
  isUniqueConstraintError,
  lockUserRow,
} from "../database/database.service";
import type { CreateStaffBodyDto } from "./dto/create-staff.dto";
import type { ListStaffQueryDto } from "./dto/list-staff.dto";
import type { UpdateCurrentUserBodyDto } from "./dto/update-current-user.dto";
import {
  UsersStaffNotFoundException,
  UsersStaffRoleConflictException,
  UsersUserNotFoundException,
} from "./users.error";
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

const staffListSelect = {
  ...staffMemberSelect,
  staffRevokedAt: true,
  roles: { select: { name: true } },
} satisfies Prisma.UserSelect;

type StaffListRecord = Prisma.UserGetPayload<{ select: typeof staffListSelect }>;

function toStaffListItem(record: StaffListRecord) {
  const { roles, staffRevokedAt, ...staff } = record;
  return {
    ...staff,
    status: roles.some(({ name }) => name === STAFF) ? "active" : "revoked",
    revokedAt: staffRevokedAt,
  };
}

@Injectable()
export class UsersService {
  constructor(private readonly databaseService: DatabaseService) {}

  async createStaff(dto: CreateStaffBodyDto) {
    try {
      return await this.createOrPromoteStaff(dto);
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
      return this.createOrPromoteStaff(dto);
    }
  }

  private createOrPromoteStaff(dto: CreateStaffBodyDto) {
    return this.databaseService.$transaction(async (tx) => {
      const existingUser = await tx.user.findFirst({
        where: { email: { equals: dto.email, mode: "insensitive" } },
        select: { id: true },
      });

      if (existingUser && (await lockUserRow(tx, existingUser.id))) {
        const lockedUser = await tx.user.findUnique({
          where: { id: existingUser.id },
          select: { roles: { select: { name: true } } },
        });

        const existingRoles = lockedUser?.roles.map(({ name }) => name) ?? [];

        if (hasStaffRoleConflict(existingRoles, STAFF)) {
          throw new UsersStaffRoleConflictException();
        }

        return tx.user.update({
          where: { id: existingUser.id },
          data: {
            staffRevokedAt: null,
            roles: { connect: { name: STAFF } },
          },
          select: staffMemberSelect,
        });
      }

      return tx.user.create({
        data: {
          name: dto.name,
          email: dto.email,
          phoneNumber: dto.phoneNumber,
          staffRevokedAt: null,
          roles: { connect: { name: STAFF } },
        },
        select: staffMemberSelect,
      });
    });
  }

  async listStaff(query: ListStaffQueryDto) {
    const activeWhere: Prisma.UserWhereInput = { roles: { some: { name: STAFF } } };
    const revokedWhere: Prisma.UserWhereInput = {
      staffRevokedAt: { not: null },
      roles: { none: { name: STAFF } },
    };
    let where: Prisma.UserWhereInput = { OR: [activeWhere, revokedWhere] };
    if (query.status === "active") {
      where = activeWhere;
    } else if (query.status === "revoked") {
      where = revokedWhere;
    }
    const [staff, total] = await Promise.all([
      this.databaseService.user.findMany({
        where,
        select: staffListSelect,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.databaseService.user.count({ where }),
    ]);

    return {
      staff: staff.map(toStaffListItem),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  revokeStaff(userId: string) {
    return this.setStaffActive(userId, false);
  }

  reinstateStaff(userId: string) {
    return this.setStaffActive(userId, true);
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

  private async setStaffActive(userId: string, active: boolean) {
    return this.databaseService.$transaction(async (tx) => {
      const userExists = await lockUserRow(tx, userId);
      const user = userExists
        ? await tx.user.findUnique({
            where: { id: userId },
            select: staffListSelect,
          })
        : null;
      const existingRoles = user?.roles.map(({ name }) => name) ?? [];
      const hasStaffRole = existingRoles.includes(STAFF);

      if (!user || (!hasStaffRole && !user.staffRevokedAt)) {
        throw new UsersStaffNotFoundException();
      }
      if (active && hasStaffRoleConflict(existingRoles, STAFF)) {
        throw new UsersStaffRoleConflictException();
      }

      const updated = await tx.user.update({
        where: { id: userId },
        data: active
          ? {
              staffRevokedAt: null,
              roles: { connect: { name: STAFF } },
            }
          : {
              staffRevokedAt: user.staffRevokedAt ?? new Date(),
              roles: { disconnect: { name: STAFF } },
            },
        select: staffListSelect,
      });

      return toStaffListItem(updated);
    });
  }
}
