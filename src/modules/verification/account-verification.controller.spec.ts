import { RequestMethod } from "@nestjs/common";
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import { ThrottlerModule } from "@nestjs/throttler";
import { DocumentStatus, DocumentType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { AuthService } from "../auth/auth.service";
import { VerifiedFleetOwnerGuard } from "../auth/guards/verified-fleet-owner.guard";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";
import { AccountVerificationController } from "./account-verification.controller";
import type { UploadedAccountDocument } from "./account-verification.dto";
import { AccountVerificationService } from "./account-verification.service";
import { PhoneVerificationService } from "./phone-verification.service";
import {
  VERIFICATION_THROTTLE_CONFIG,
  VerificationThrottlerGuard,
} from "./verification-throttler.guard";

describe("AccountVerificationController", () => {
  let controller: AccountVerificationController;
  let accountVerificationService: {
    replaceRejectedDriversLicense: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
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

  const licenseFile = (): UploadedAccountDocument => ({
    originalname: "license.pdf",
    mimetype: "application/pdf",
    size: 1024,
    buffer: Buffer.from("license-pdf"),
  });

  beforeEach(async () => {
    accountVerificationService = {
      replaceRejectedDriversLicense: vi.fn(),
      create: vi.fn(),
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
      controllers: [AccountVerificationController],
      providers: [
        VerificationThrottlerGuard,
        { provide: AccountVerificationService, useValue: accountVerificationService },
        {
          provide: PhoneVerificationService,
          useValue: { send: vi.fn(), check: vi.fn() },
        },
        {
          provide: FlutterwaveService,
          useValue: { listNigerianBanks: vi.fn() },
        },
        {
          provide: AuthService,
          useValue: {
            isInitialized: true,
            auth: {
              api: {
                getSession: vi.fn().mockResolvedValue(null),
              },
            },
            getUserRoles: vi.fn().mockResolvedValue(["fleetOwner"]),
          },
        },
        Reflector,
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    controller = module.get(AccountVerificationController);
  });

  const replaceRejectedDriversLicense = (user: typeof mockUser, file: UploadedAccountDocument) =>
    (
      controller as AccountVerificationController & {
        replaceRejectedDriversLicense: (
          user: typeof mockUser,
          file: UploadedAccountDocument,
        ) => Promise<unknown>;
      }
    ).replaceRejectedDriversLicense(user, file);

  it("does not require an approved fleet-owner account for onboarding recovery", () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, AccountVerificationController) ?? [];
    expect(guards).not.toContain(VerifiedFleetOwnerGuard);
  });

  it("exposes PUT /api/fleet-owner/documents/drivers-license", () => {
    const handler = (
      AccountVerificationController.prototype as AccountVerificationController & {
        replaceRejectedDriversLicense?: (...args: unknown[]) => unknown;
      }
    ).replaceRejectedDriversLicense;
    expect(handler).toEqual(expect.any(Function));
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe("documents/drivers-license");
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.PUT);
  });

  it("replaces a rejected driver's licence (PUT /api/fleet-owner/documents/drivers-license)", async () => {
    const file = licenseFile();
    const updated = {
      id: "doc-1",
      documentType: DocumentType.DRIVERS_LICENSE,
      status: DocumentStatus.PENDING,
    };
    accountVerificationService.replaceRejectedDriversLicense.mockResolvedValueOnce(updated);

    await expect(replaceRejectedDriversLicense(mockUser, file)).resolves.toEqual(updated);
    expect(accountVerificationService.replaceRejectedDriversLicense).toHaveBeenCalledWith(
      "owner-1",
      file,
    );
    expect(accountVerificationService.create).not.toHaveBeenCalled();
  });
});
