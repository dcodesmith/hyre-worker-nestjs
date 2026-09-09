import { type ExecutionContext } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { FleetOwnerStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseService } from "../../database/database.service";
import { ADMIN, STAFF } from "../auth.const";
import { AuthErrorCode, AuthForbiddenException } from "../auth.error";
import type { RoleName } from "../auth.interface";
import { AUTH_SESSION_KEY, type AuthSession } from "./session.guard";
import { VerifiedFleetOwnerGuard } from "./verified-fleet-owner.guard";

describe("VerifiedFleetOwnerGuard", () => {
  let guard: VerifiedFleetOwnerGuard;
  let databaseService: { user: { findUnique: ReturnType<typeof vi.fn> } };

  const session: AuthSession = {
    user: {
      id: "owner-1",
      email: "owner@example.com",
      name: "Owner",
      emailVerified: true,
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      roles: ["fleetOwner"],
    },
    session: {
      id: "session-1",
      userId: "owner-1",
      expiresAt: new Date(Date.now() + 60_000),
      token: "token-1",
      createdAt: new Date(),
      updatedAt: new Date(),
      ipAddress: "127.0.0.1",
      userAgent: "test-agent",
    },
  };

  const verifiedOwner = {
    emailVerified: true,
    phoneVerifiedAt: new Date(),
    hasOnboarded: true,
    fleetOwnerStatus: FleetOwnerStatus.APPROVED,
  };

  const sessionWithRoles = (roles: RoleName[]): AuthSession => ({
    ...session,
    user: { ...session.user, roles },
  });

  const createContext = (attachedSession?: AuthSession) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ [AUTH_SESSION_KEY]: attachedSession }),
      }),
    }) as unknown as ExecutionContext;

  beforeEach(async () => {
    databaseService = { user: { findUnique: vi.fn().mockResolvedValue(verifiedOwner) } };

    const module: TestingModule = await Test.createTestingModule({
      providers: [VerifiedFleetOwnerGuard, { provide: DatabaseService, useValue: databaseService }],
    }).compile();

    guard = module.get(VerifiedFleetOwnerGuard);
  });

  it.each([ADMIN, STAFF] as const)(
    "allows %s without looking up fleet-owner verification",
    async (role) => {
      await expect(guard.canActivate(createContext(sessionWithRoles([role])))).resolves.toBe(true);
      expect(databaseService.user.findUnique).not.toHaveBeenCalled();
    },
  );

  it("allows a fully verified onboarded fleet owner", async () => {
    await expect(guard.canActivate(createContext(session))).resolves.toBe(true);
    expect(databaseService.user.findUnique).toHaveBeenCalledWith({
      where: { id: "owner-1" },
      select: {
        emailVerified: true,
        phoneVerifiedAt: true,
        hasOnboarded: true,
        fleetOwnerStatus: true,
      },
    });
  });

  it.each([
    { emailVerified: false },
    { phoneVerifiedAt: null },
    { hasOnboarded: false },
    { fleetOwnerStatus: FleetOwnerStatus.PROCESSING },
  ])("denies an owner missing verification (%j)", async (override) => {
    databaseService.user.findUnique.mockResolvedValueOnce({ ...verifiedOwner, ...override });

    await expect(guard.canActivate(createContext(session))).rejects.toMatchObject({
      constructor: AuthForbiddenException,
      response: expect.objectContaining({
        errorCode: AuthErrorCode.AUTH_FLEET_OWNER_VERIFICATION_REQUIRED,
      }),
    });
  });

  it("denies a request with no session user", async () => {
    await expect(guard.canActivate(createContext(undefined))).rejects.toBeInstanceOf(
      AuthForbiddenException,
    );
    expect(databaseService.user.findUnique).not.toHaveBeenCalled();
  });
});
