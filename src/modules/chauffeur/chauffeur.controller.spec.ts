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
  let controller: FleetOwnerChauffeurController;
  let chauffeurService: {
    createInvitation: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };

  const mockUser = {
    id: "owner-1",
    name: "Fleet Owner",
    email: "owner@example.com",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    roles: ["fleetOwner" as const],
  };

  beforeEach(async () => {
    chauffeurService = {
      createInvitation: vi.fn(),
      list: vi.fn(),
      update: vi.fn(),
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
      controllers: [FleetOwnerChauffeurController],
      providers: [
        VerificationThrottlerGuard,
        { provide: ChauffeurService, useValue: chauffeurService },
        { provide: DatabaseService, useValue: { user: { findUnique: vi.fn() } } },
        {
          provide: ConfigService,
          useValue: { get: vi.fn(() => "test-hmac-key") },
        },
        {
          provide: AuthService,
          useValue: {
            isInitialized: true,
            auth: { api: { getSession: vi.fn().mockResolvedValue(null) } },
            getUserRoles: vi.fn().mockResolvedValue(["fleetOwner"]),
          },
        },
        Reflector,
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();
    controller = module.get(FleetOwnerChauffeurController);
  });

  it("protects owner routes with session, role, and verified fleet-owner guards", () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, FleetOwnerChauffeurController) ?? [];
    expect(guards).toEqual(
      expect.arrayContaining([SessionGuard, RoleGuard, VerifiedFleetOwnerGuard]),
    );
    expect(Reflect.getMetadata(ROLES_KEY, FleetOwnerChauffeurController)).toEqual([FLEET_OWNER]);
  });

  it("delegates invitation creation with the idempotency key", async () => {
    const body = { name: "Ada Lovelace", email: "ada@example.com", phoneNumber: "+2348012345678" };
    chauffeurService.createInvitation.mockResolvedValueOnce({ id: "ver-1" });

    await expect(controller.createInvitation("invite-key-1", body, mockUser)).resolves.toEqual({
      id: "ver-1",
    });
    expect(chauffeurService.createInvitation).toHaveBeenCalledWith("owner-1", "invite-key-1", body);
  });

  it("delegates list and deactivate", async () => {
    chauffeurService.list.mockResolvedValueOnce({
      items: [],
      meta: { page: 1, limit: 20, total: 0 },
    });
    chauffeurService.update.mockResolvedValueOnce({ id: "ver-1", isActive: false });

    await expect(controller.list(mockUser, { page: 1, limit: 20 })).resolves.toMatchObject({
      items: [],
    });
    await expect(
      controller.update(mockUser, "ckx7b9q1e0000qwertyuiopas", { isActive: false }),
    ).resolves.toMatchObject({ isActive: false });
  });
});

describe("ChauffeurOnboardingController", () => {
  let controller: ChauffeurOnboardingController;
  let chauffeurService: {
    exchangeInvitation: ReturnType<typeof vi.fn>;
    getOnboarding: ReturnType<typeof vi.fn>;
    acceptConsent: ReturnType<typeof vi.fn>;
    sendPhoneVerification: ReturnType<typeof vi.fn>;
    checkPhoneVerification: ReturnType<typeof vi.fn>;
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
      exchangeInvitation: vi.fn(),
      getOnboarding: vi.fn(),
      acceptConsent: vi.fn(),
      sendPhoneVerification: vi.fn(),
      checkPhoneVerification: vi.fn(),
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

  it("delegates exchange, consent, and phone checks", async () => {
    chauffeurService.exchangeInvitation.mockResolvedValueOnce({ sessionToken: "session-1" });
    chauffeurService.acceptConsent.mockResolvedValueOnce({ status: "CONSENTED" });
    chauffeurService.checkPhoneVerification.mockResolvedValueOnce({ status: "VERIFIED" });

    await expect(controller.exchangeInvitation({ token: "a".repeat(32) })).resolves.toEqual({
      sessionToken: "session-1",
    });
    await expect(
      controller.acceptConsent("ver-1", { termsAccepted: true, privacyAccepted: true }),
    ).resolves.toEqual({ status: "CONSENTED" });
    await expect(controller.checkPhoneVerification("ver-1", { code: "123456" })).resolves.toEqual({
      status: "VERIFIED",
    });
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
          { driversLicenseNumber: "ABC12345" },
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
