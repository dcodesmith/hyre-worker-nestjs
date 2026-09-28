import { RequestMethod } from "@nestjs/common";
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import { ThrottlerModule } from "@nestjs/throttler";
import type { Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { FLEET_OWNER } from "../auth/auth.const";
import { AuthService } from "../auth/auth.service";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { RoleGuard } from "../auth/guards/role.guard";
import { SessionGuard } from "../auth/guards/session.guard";
import { VerifiedFleetOwnerGuard } from "../auth/guards/verified-fleet-owner.guard";
import { DatabaseService } from "../database/database.service";
import {
  VERIFICATION_THROTTLE_CONFIG,
  VerificationThrottlerGuard,
} from "../verification/verification-throttler.guard";
import {
  ChauffeurOnboardingController,
  FleetOwnerChauffeurController,
} from "./chauffeur.controller";
import { ChauffeurRequestInProgressException } from "./chauffeur.error";
import { ChauffeurService } from "./chauffeur.service";
import { ChauffeurSessionGuard } from "./chauffeur-session.guard";

describe("FleetOwnerChauffeurController", () => {
  it("protects owner routes with session, role, and verified fleet-owner guards", () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, FleetOwnerChauffeurController) ?? [];
    expect(guards).toEqual(
      expect.arrayContaining([SessionGuard, RoleGuard, VerifiedFleetOwnerGuard]),
    );
    expect(Reflect.getMetadata(ROLES_KEY, FleetOwnerChauffeurController)).toEqual([FLEET_OWNER]);
  });
});

describe("ChauffeurOnboardingController", () => {
  let controller: ChauffeurOnboardingController;
  let chauffeurService: {
    verifyNin: ReturnType<typeof vi.fn>;
    verifyDriving: ReturnType<typeof vi.fn>;
  };

  const selfie = {
    mimetype: "image/jpeg",
    size: 4,
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  };

  const createMockResponse = () => ({ setHeader: vi.fn() }) as unknown as Response;

  beforeEach(async () => {
    chauffeurService = {
      verifyNin: vi.fn(),
      verifyDriving: vi.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([
          {
            name: VERIFICATION_THROTTLE_CONFIG.name,
            ttl: VERIFICATION_THROTTLE_CONFIG.ttlMs,
            limit: VERIFICATION_THROTTLE_CONFIG.limit,
          },
        ]),
      ],
      controllers: [ChauffeurOnboardingController],
      providers: [
        VerificationThrottlerGuard,
        { provide: ChauffeurService, useValue: chauffeurService },
        {
          provide: ChauffeurSessionGuard,
          useValue: { canActivate: vi.fn().mockResolvedValue(true) },
        },
        { provide: DatabaseService, useValue: { chauffeurVerification: { findFirst: vi.fn() } } },
        {
          provide: ConfigService,
          useValue: { get: vi.fn(() => "test-hmac-key") },
        },
        {
          provide: AuthService,
          useValue: { isInitialized: true, auth: { api: { getSession: vi.fn() } } },
        },
        Reflector,
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();
    controller = module.get(ChauffeurOnboardingController);
  });

  it("exposes public exchange and session-guarded onboarding routes", () => {
    const exchange = ChauffeurOnboardingController.prototype.exchangeInvitation as object;
    expect(Reflect.getMetadata(PATH_METADATA, exchange)).toBe("invitation-exchanges");
    expect(Reflect.getMetadata(METHOD_METADATA, exchange)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(GUARDS_METADATA, exchange)).toEqual(
      expect.arrayContaining([VerificationThrottlerGuard]),
    );

    const getOnboarding = ChauffeurOnboardingController.prototype.get as object;
    expect(Reflect.getMetadata(GUARDS_METADATA, getOnboarding)).toEqual(
      expect.arrayContaining([ChauffeurSessionGuard]),
    );
  });

  it.each([
    [
      "nin",
      (response: Response) =>
        controller.verifyNin("ver-1", "nin-key-1", { nin: "12345678901" }, response),
      "verifyNin",
    ],
    [
      "driving",
      (response: Response) =>
        controller.verifyDriving(
          "ver-1",
          "drive-key-1",
          { driversLicenseNumber: "ABC12345DE67" },
          selfie,
          response,
        ),
      "verifyDriving",
    ],
  ] as const)(
    "sets Retry-After when an identical %s request is processing",
    async (_label, invoke, serviceMethod) => {
      const response = createMockResponse();
      chauffeurService[serviceMethod].mockRejectedValueOnce(
        new ChauffeurRequestInProgressException(),
      );

      await expect(invoke(response)).rejects.toBeInstanceOf(ChauffeurRequestInProgressException);
      expect(response.setHeader).toHaveBeenCalledWith("Retry-After", "5");
    },
  );
});
