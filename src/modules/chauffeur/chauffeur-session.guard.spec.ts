import { createHmac } from "node:crypto";
import type { ExecutionContext } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseService } from "../database/database.service";
import { ChauffeurSessionInvalidException } from "./chauffeur.error";
import { CHAUFFEUR_VERIFICATION_ID, ChauffeurSessionGuard } from "./chauffeur-session.guard";

const HMAC_KEY = "test-hmac-key";
const TOKEN = "a".repeat(43);

function hash(value: string): string {
  return createHmac("sha256", HMAC_KEY).update(value).digest("hex");
}

describe("ChauffeurSessionGuard", () => {
  let guard: ChauffeurSessionGuard;
  let databaseService: { chauffeurVerification: { findFirst: ReturnType<typeof vi.fn> } };

  const createContext = (authorization?: string) => {
    const request = {
      headers: authorization ? { authorization } : {},
      [CHAUFFEUR_VERIFICATION_ID]: undefined,
    };
    return {
      switchToHttp: () => ({ getRequest: () => request }),
      getRequest: () => request,
    } as unknown as ExecutionContext & { getRequest: () => typeof request };
  };

  beforeEach(async () => {
    databaseService = {
      chauffeurVerification: { findFirst: vi.fn() },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChauffeurSessionGuard,
        { provide: DatabaseService, useValue: databaseService },
        {
          provide: ConfigService,
          useValue: { get: vi.fn((key: string) => (key === "HMAC_KEY" ? HMAC_KEY : undefined)) },
        },
      ],
    }).compile();
    guard = module.get(ChauffeurSessionGuard);
  });

  it("attaches the verification id when a live session token is presented", async () => {
    databaseService.chauffeurVerification.findFirst.mockResolvedValueOnce({ id: "ver-1" });
    const context = createContext(`Bearer ${TOKEN}`);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(databaseService.chauffeurVerification.findFirst).toHaveBeenCalledWith({
      where: {
        sessionTokenHash: hash(TOKEN),
        sessionExpiresAt: { gt: expect.any(Date) },
      },
      select: { id: true },
    });
    expect(context.getRequest()[CHAUFFEUR_VERIFICATION_ID]).toBe("ver-1");
  });

  it("rejects a missing bearer token", async () => {
    await expect(guard.canActivate(createContext())).rejects.toBeInstanceOf(
      ChauffeurSessionInvalidException,
    );
    expect(databaseService.chauffeurVerification.findFirst).not.toHaveBeenCalled();
  });

  it("rejects an unknown or expired session", async () => {
    databaseService.chauffeurVerification.findFirst.mockResolvedValueOnce(null);

    await expect(guard.canActivate(createContext(`Bearer ${TOKEN}`))).rejects.toBeInstanceOf(
      ChauffeurSessionInvalidException,
    );
  });
});
