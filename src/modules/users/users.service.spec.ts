import { Test, type TestingModule } from "@nestjs/testing";
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STAFF } from "../auth/auth.const";
import { DatabaseService } from "../database/database.service";
import {
  UsersStaffNotFoundException,
  UsersStaffRoleConflictException,
  UsersUserNotFoundException,
} from "./users.error";
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

const uniqueConstraintError = () =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
  });

describe("UsersService", () => {
  let service: UsersService;
  let databaseService: {
    $transaction: ReturnType<typeof vi.fn>;
    $queryRaw: ReturnType<typeof vi.fn>;
    user: {
      findUnique: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    databaseService = {
      $transaction: vi.fn(async (callback) => callback(databaseService)),
      $queryRaw: vi.fn().mockResolvedValue([{ id: "staff-1" }]),
      user: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
        update: vi.fn(),
        create: vi.fn(),
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

    const emailLookup = {
      where: { email: { equals: staffDto.email, mode: "insensitive" } },
      select: { id: true },
    };

    it("creates a staff member when no matching email exists", async () => {
      databaseService.user.findFirst.mockResolvedValue(null);
      databaseService.user.create.mockResolvedValue(staffMember);

      await expect(service.createStaff(staffDto)).resolves.toEqual(staffMember);
      expect(databaseService.$transaction).toHaveBeenCalledOnce();
      expect(databaseService.user.findFirst).toHaveBeenCalledWith(emailLookup);
      expect(databaseService.$queryRaw).not.toHaveBeenCalled();
      expect(databaseService.user.create).toHaveBeenCalledWith({
        data: {
          name: staffDto.name,
          email: staffDto.email,
          phoneNumber: staffDto.phoneNumber,
          staffRevokedAt: null,
          roles: { connect: { name: STAFF } },
        },
        select: staffSelect,
      });
      expect(databaseService.$queryRaw).not.toHaveBeenCalled();
      expect(databaseService.user.update).not.toHaveBeenCalled();
    });

    it("retries as a promotion when concurrent creation wins the email constraint", async () => {
      databaseService.user.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: staffMember.id });
      databaseService.user.create.mockRejectedValueOnce(uniqueConstraintError());
      databaseService.user.findUnique.mockResolvedValue({ roles: [{ name: "user" }] });
      databaseService.user.update.mockResolvedValue(staffMember);

      await expect(service.createStaff(staffDto)).resolves.toEqual(staffMember);

      expect(databaseService.$transaction).toHaveBeenCalledTimes(2);
      expect(databaseService.user.create).toHaveBeenCalledOnce();
      expect(databaseService.$queryRaw).toHaveBeenCalledOnce();
      expect(databaseService.user.update).toHaveBeenCalledWith({
        where: { id: staffMember.id },
        data: {
          staffRevokedAt: null,
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
      databaseService.user.findFirst.mockResolvedValue({ id: existing.id });
      databaseService.$queryRaw.mockResolvedValue([{ id: existing.id }]);
      databaseService.user.findUnique.mockResolvedValue({ roles: [{ name: "user" }] });
      databaseService.user.update.mockResolvedValue(existing);

      const result = await service.createStaff({
        name: "Should Not Overwrite",
        email: staffDto.email,
        phoneNumber: "+2348099999999",
      });

      expect(databaseService.$transaction).toHaveBeenCalledOnce();
      expect(databaseService.user.findFirst).toHaveBeenCalledWith(emailLookup);
      expect(databaseService.$queryRaw).toHaveBeenCalledOnce();
      expect(databaseService.user.findUnique).toHaveBeenCalledWith({
        where: { id: existing.id },
        select: { roles: { select: { name: true } } },
      });
      expect(databaseService.user.update).toHaveBeenCalledWith({
        where: { id: existing.id },
        data: {
          staffRevokedAt: null,
          roles: { connect: { name: STAFF } },
        },
        select: staffSelect,
      });
      expect(databaseService.user.create).not.toHaveBeenCalled();
      expect(result).toEqual(existing);
    });

    it.each(["admin", "fleetOwner", "chauffeur"])(
      "rejects an existing user with the %s role",
      async (role) => {
        databaseService.user.findFirst.mockResolvedValue({ id: "incompatible-1" });
        databaseService.$queryRaw.mockResolvedValue([{ id: "incompatible-1" }]);
        databaseService.user.findUnique.mockResolvedValue({ roles: [{ name: role }] });

        await expect(service.createStaff(staffDto)).rejects.toBeInstanceOf(
          UsersStaffRoleConflictException,
        );
        expect(databaseService.$queryRaw).toHaveBeenCalledOnce();
        expect(databaseService.user.update).not.toHaveBeenCalled();
        expect(databaseService.user.create).not.toHaveBeenCalled();
      },
    );
  });

  describe("listStaff", () => {
    const activeWhere = { roles: { some: { name: STAFF } } };
    const revokedWhere = {
      staffRevokedAt: { not: null },
      roles: { none: { name: STAFF } },
    };
    const staffListSelect = {
      id: true,
      name: true,
      email: true,
      phoneNumber: true,
      createdAt: true,
      staffRevokedAt: true,
      roles: { select: { name: true } },
    };
    const staffMember = {
      id: "staff-1",
      name: "Ada Lovelace",
      email: "ada@example.com",
      phoneNumber: "+2348012345678",
      createdAt: new Date("2026-01-15T00:00:00.000Z"),
    };

    it.each([
      [undefined, { OR: [activeWhere, revokedWhere] }],
      ["active" as const, activeWhere],
      ["revoked" as const, revokedWhere],
    ])("filters staff by status %s", async (status, where) => {
      databaseService.user.findMany.mockResolvedValue([]);
      databaseService.user.count.mockResolvedValue(0);

      await service.listStaff({ page: 1, limit: 20, status });

      expect(databaseService.user.findMany).toHaveBeenCalledWith({
        where,
        select: staffListSelect,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: 0,
        take: 20,
      });
      expect(databaseService.user.count).toHaveBeenCalledWith({ where });
    });

    it("maps staff status and returns pagination meta", async () => {
      const revokedAt = new Date("2026-03-01T00:00:00.000Z");
      databaseService.user.findMany.mockResolvedValue([
        { ...staffMember, staffRevokedAt: null, roles: [{ name: STAFF }] },
        { ...staffMember, id: "staff-2", staffRevokedAt: revokedAt, roles: [] },
      ]);
      databaseService.user.count.mockResolvedValue(21);

      await expect(service.listStaff({ page: 2, limit: 10 })).resolves.toEqual({
        staff: [
          { ...staffMember, status: "active", revokedAt: null },
          { ...staffMember, id: "staff-2", status: "revoked", revokedAt },
        ],
        meta: { page: 2, limit: 10, total: 21, totalPages: 3 },
      });
      expect(databaseService.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 10, take: 10 }),
      );
    });
  });

  describe("revokeStaff and reinstateStaff", () => {
    const staffMember = {
      id: "staff-1",
      name: "Ada Lovelace",
      email: "ada@example.com",
      phoneNumber: "+2348012345678",
      createdAt: new Date("2026-01-15T00:00:00.000Z"),
    };
    const staffListSelect = {
      id: true,
      name: true,
      email: true,
      phoneNumber: true,
      createdAt: true,
      staffRevokedAt: true,
      roles: { select: { name: true } },
    };
    const revokedAt = new Date("2026-03-01T00:00:00.000Z");

    function mockLockedUser(
      record: {
        id: string;
        staffRevokedAt: Date | null;
        roles: Array<{ name: string }>;
      } | null,
    ) {
      databaseService.$queryRaw.mockResolvedValue(record ? [{ id: record.id }] : []);
      databaseService.user.findUnique.mockResolvedValue(record);
    }

    it("revokes active staff and keeps a later revoke idempotent", async () => {
      mockLockedUser({ ...staffMember, staffRevokedAt: null, roles: [{ name: STAFF }] });
      databaseService.user.update.mockResolvedValue({
        ...staffMember,
        staffRevokedAt: revokedAt,
        roles: [],
      });

      await expect(service.revokeStaff(staffMember.id)).resolves.toEqual({
        ...staffMember,
        status: "revoked",
        revokedAt,
      });
      expect(databaseService.$transaction).toHaveBeenCalledOnce();
      expect(databaseService.$queryRaw).toHaveBeenCalledOnce();
      expect(databaseService.user.update).toHaveBeenCalledWith({
        where: { id: staffMember.id },
        data: {
          staffRevokedAt: expect.any(Date),
          roles: { disconnect: { name: STAFF } },
        },
        select: staffListSelect,
      });

      mockLockedUser({ ...staffMember, staffRevokedAt: revokedAt, roles: [] });
      databaseService.user.update.mockResolvedValue({
        ...staffMember,
        staffRevokedAt: revokedAt,
        roles: [],
      });

      await service.revokeStaff(staffMember.id);
      expect(databaseService.user.update).toHaveBeenLastCalledWith({
        where: { id: staffMember.id },
        data: {
          staffRevokedAt: revokedAt,
          roles: { disconnect: { name: STAFF } },
        },
        select: staffListSelect,
      });
    });

    it("reinstates revoked staff and keeps a later reinstate idempotent", async () => {
      mockLockedUser({ ...staffMember, staffRevokedAt: revokedAt, roles: [] });
      databaseService.user.update.mockResolvedValue({
        ...staffMember,
        staffRevokedAt: null,
        roles: [{ name: STAFF }],
      });

      await expect(service.reinstateStaff(staffMember.id)).resolves.toEqual({
        ...staffMember,
        status: "active",
        revokedAt: null,
      });
      expect(databaseService.user.update).toHaveBeenCalledWith({
        where: { id: staffMember.id },
        data: {
          staffRevokedAt: null,
          roles: { connect: { name: STAFF } },
        },
        select: staffListSelect,
      });

      mockLockedUser({
        ...staffMember,
        staffRevokedAt: null,
        roles: [{ name: STAFF }],
      });
      await service.reinstateStaff(staffMember.id);
      expect(databaseService.user.update).toHaveBeenLastCalledWith({
        where: { id: staffMember.id },
        data: {
          staffRevokedAt: null,
          roles: { connect: { name: STAFF } },
        },
        select: staffListSelect,
      });
    });

    it("returns not found for a missing or never-staff user", async () => {
      mockLockedUser(null);
      await expect(service.revokeStaff("missing-user")).rejects.toBeInstanceOf(
        UsersStaffNotFoundException,
      );

      mockLockedUser({ ...staffMember, staffRevokedAt: null, roles: [{ name: "user" }] });
      await expect(service.reinstateStaff(staffMember.id)).rejects.toBeInstanceOf(
        UsersStaffNotFoundException,
      );
      expect(databaseService.user.update).not.toHaveBeenCalled();
    });

    it("rejects reinstating a user with an incompatible role", async () => {
      mockLockedUser({
        ...staffMember,
        staffRevokedAt: revokedAt,
        roles: [{ name: "fleetOwner" }],
      });

      await expect(service.reinstateStaff(staffMember.id)).rejects.toBeInstanceOf(
        UsersStaffRoleConflictException,
      );
      expect(databaseService.user.update).not.toHaveBeenCalled();
    });
  });
});
