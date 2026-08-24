import { Test, type TestingModule } from "@nestjs/testing";
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseService } from "../database/database.service";
import { UsersUserNotFoundException } from "./users.error";
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
  let databaseService: DatabaseService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        {
          provide: DatabaseService,
          useValue: {
            user: {
              findUnique: vi.fn(),
              update: vi.fn(),
            },
          },
        },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
    databaseService = module.get<DatabaseService>(DatabaseService);
  });

  it("returns the current user's editable profile", async () => {
    vi.mocked(databaseService.user.findUnique).mockResolvedValue(profile as never);

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
    vi.mocked(databaseService.user.findUnique).mockResolvedValue(null);

    await expect(service.getCurrentUserProfile("missing-user")).rejects.toThrow(
      UsersUserNotFoundException,
    );
  });

  it("updates only the provided profile fields", async () => {
    const updated = { ...profile, city: "Abuja", marketingConsent: true };
    vi.mocked(databaseService.user.update).mockResolvedValue(updated as never);

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
    vi.mocked(databaseService.user.update).mockRejectedValue(recordNotFoundError());

    await expect(
      service.updateCurrentUserProfile("missing-user", { city: "Lagos" }),
    ).rejects.toThrow(UsersUserNotFoundException);
  });

  it("rethrows unexpected update errors", async () => {
    const unexpected = new Error("db failure");
    vi.mocked(databaseService.user.update).mockRejectedValue(unexpected);

    await expect(service.updateCurrentUserProfile("user-1", { city: "Lagos" })).rejects.toBe(
      unexpected,
    );
  });
});
