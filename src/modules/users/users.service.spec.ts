import { Test, type TestingModule } from "@nestjs/testing";
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STAFF } from "../auth/auth.const";
import { DatabaseService } from "../database/database.service";
import { UsersStaffRoleConflictException, UsersUserNotFoundException } from "./users.error";
import { UsersService } from "./users.service";

const profile = {
  name: "Ada Lovelace",
  phoneNumber: "+2348012345678",
  city: "Lagos",
  address: "12 Marina",
  marketingConsent: false,
};

const recordNotFoundError = () =>
  new Prisma.PrismaClientKnownRequestError("Record not found", {
    code: "P2025",
    clientVersion: "test",
  });

describe("UsersService", () => {
  let service: UsersService;
  let databaseService: {
    user: {
      findUnique: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    databaseService = {
      user: {
        findUnique: vi.fn(),
        update: vi.fn(),
        upsert: vi.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        {
          provide: DatabaseService,
          useValue: databaseService,
        },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  it("returns the current user's editable profile", async () => {
    databaseService.user.findUnique.mockResolvedValue(profile);

    await expect(service.getCurrentUserProfile("user-1")).resolves.toEqual(profile);
    expect(databaseService.user.findUnique).toHaveBeenCalledWith({
      where: { id: "user-1" },
      select: {
        name: true,
        phoneNumber: true,
        city: true,
        address: true,
        marketingConsent: true,
      },
    });
  });

  it("throws not found when the current user is missing", async () => {
    databaseService.user.findUnique.mockResolvedValue(null);

    await expect(service.getCurrentUserProfile("missing-user")).rejects.toThrow(
      UsersUserNotFoundException,
    );
  });

  it("updates only the provided profile fields", async () => {
    const updated = { ...profile, city: "Abuja", marketingConsent: true };
    databaseService.user.update.mockResolvedValue(updated);

    const result = await service.updateCurrentUserProfile("user-1", {
      city: "Abuja",
      marketingConsent: true,
    });

    expect(databaseService.user.findUnique).not.toHaveBeenCalled();
    expect(databaseService.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        name: undefined,
        phoneNumber: undefined,
        city: "Abuja",
        address: undefined,
        marketingConsent: true,
      },
      select: {
        name: true,
        phoneNumber: true,
        city: true,
        address: true,
        marketingConsent: true,
      },
    });
    expect(result).toEqual(updated);
  });

  it("throws not found when updating a missing user", async () => {
    databaseService.user.update.mockRejectedValue(recordNotFoundError());

    await expect(
      service.updateCurrentUserProfile("missing-user", { city: "Lagos" }),
    ).rejects.toThrow(UsersUserNotFoundException);
  });

  it("rethrows unexpected update errors", async () => {
    const unexpected = new Error("db failure");
    databaseService.user.update.mockRejectedValue(unexpected);

    await expect(service.updateCurrentUserProfile("user-1", { city: "Lagos" })).rejects.toBe(
      unexpected,
    );
  });

  describe("createStaff", () => {
    const staffDto = {
      name: "Ada Lovelace",
      email: "ada@example.com",
      phoneNumber: "+2348012345678",
    };
    const staffMember = {
      id: "staff-1",
      name: staffDto.name,
      email: staffDto.email,
      phoneNumber: staffDto.phoneNumber,
      createdAt: new Date("2026-01-15T00:00:00.000Z"),
    };
    const staffSelect = {
      id: true,
      name: true,
      email: true,
      phoneNumber: true,
      createdAt: true,
    };

    it("upserts by email, creates profile fields, and returns the selected member", async () => {
      databaseService.user.upsert.mockResolvedValue(staffMember);

      await expect(service.createStaff(staffDto)).resolves.toEqual(staffMember);
      expect(databaseService.user.findUnique).toHaveBeenCalledWith({
        where: { email: staffDto.email },
        select: { roles: { select: { name: true } } },
      });
      expect(databaseService.user.upsert).toHaveBeenCalledWith({
        where: { email: staffDto.email },
        update: {
          roles: { connect: { name: STAFF } },
        },
        create: {
          name: staffDto.name,
          email: staffDto.email,
          phoneNumber: staffDto.phoneNumber,
          roles: { connect: { name: STAFF } },
        },
        select: staffSelect,
      });
    });

    it("connects staff on the existing path without updating profile fields", async () => {
      const existing = {
        ...staffMember,
        name: "Original Name",
        phoneNumber: "+2348011111111",
      };
      databaseService.user.findUnique.mockResolvedValue({
        roles: [{ name: "user" }],
      });
      databaseService.user.upsert.mockResolvedValue(existing);

      const result = await service.createStaff({
        name: "Should Not Overwrite",
        email: staffDto.email,
        phoneNumber: "+2348099999999",
      });

      expect(databaseService.user.upsert).toHaveBeenCalledWith({
        where: { email: staffDto.email },
        update: {
          roles: { connect: { name: STAFF } },
        },
        create: {
          name: "Should Not Overwrite",
          email: staffDto.email,
          phoneNumber: "+2348099999999",
          roles: { connect: { name: STAFF } },
        },
        select: staffSelect,
      });
      expect(result).toEqual(existing);
    });

    it.each(["admin", "fleetOwner", "chauffeur"])(
      "rejects an existing user with the %s role",
      async (role) => {
        databaseService.user.findUnique.mockResolvedValue({
          roles: [{ name: role }],
        });

        await expect(service.createStaff(staffDto)).rejects.toBeInstanceOf(
          UsersStaffRoleConflictException,
        );
        expect(databaseService.user.upsert).not.toHaveBeenCalled();
      },
    );
  });
});
